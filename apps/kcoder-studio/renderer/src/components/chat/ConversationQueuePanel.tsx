import { useEffect, useMemo, useState } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CornerDownRight,
  GripVertical,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { canCancelInput, isVisibleQueueInput } from '@/features/workbench/inputDelivery'
import { useTranslation } from '@/hooks/useTranslation'
import type { GuidanceWorkbenchMessage, QueuedWorkbenchMessage } from '@/types/workbench'
import { ComposerStatusItem } from './composer/ComposerStatusRegion'

interface ConversationQueuePanelProps {
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  onCancelQueuedMessage?: (id: string, action?: 'cancel' | 'dismiss') => void
  onSendQueuedAsGuidance?: (id: string) => void
  onInterruptAndSendQueuedMessage?: (id: string) => void
  onEditQueuedMessage?: (id: string) => void
  onReorderQueuedMessages?: (sourceId: string, targetId: string) => void
  queuePaused?: boolean
  onResumeQueue?: () => void
  onCancelGuidanceMessage?: (id: string) => void
  presentation?: 'detail' | 'embedded'
}

export function ConversationQueuePanel({
  queuedMessages: submissions,
  guidanceMessages: guidances,
  onCancelQueuedMessage,
  onSendQueuedAsGuidance,
  onInterruptAndSendQueuedMessage,
  onEditQueuedMessage,
  onReorderQueuedMessages,
  queuePaused = false,
  onResumeQueue,
  onCancelGuidanceMessage,
  presentation,
}: ConversationQueuePanelProps) {
  const { t } = useTranslation('chat')
  const queuedMessages = useMemo(() => submissions.filter(isVisibleQueueInput), [submissions])
  const guidanceMessages = useMemo(() => guidances.filter(message => message.status !== 'applied'), [guidances])
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const hasMessages = queuedMessages.length > 0 || guidanceMessages.length > 0
  const sendingOnly =
    hasMessages &&
    !queuePaused &&
    queuedMessages.every(message => message.status === 'sending') &&
    guidanceMessages.every(message => message.status === 'sending')
  const ownerKey = JSON.stringify(
    [...new Set(queuedMessages.flatMap(message =>
      'ownerKey' in message && typeof message.ownerKey === 'string' ? [message.ownerKey] : []
    ))].sort()
  )
  const queueItemKey = JSON.stringify([
    queuedMessages.map(message => ['queued', message.id]),
    guidanceMessages.map(message => ['guidance', message.id]),
  ])
  const [shownOwnerKey, setShownOwnerKey] = useState<string | null>(null)
  // Backlogs and attention states mark their owner visible for later updates.
  if (!hasMessages && shownOwnerKey !== null) setShownOwnerKey(null)
  else if (hasMessages && !sendingOnly && shownOwnerKey !== ownerKey)
    setShownOwnerKey(ownerKey)
  useEffect(() => {
    if (!hasMessages || !sendingOnly || shownOwnerKey === ownerKey) return

    // A different item set gets a fresh delay instead of inheriting the old timer.
    let cancelled = false
    const timeout = window.setTimeout(() => {
      if (cancelled) return
      setShownOwnerKey(ownerKey)
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [hasMessages, ownerKey, queueItemKey, sendingOnly, shownOwnerKey])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const queuedMessageIds = useMemo(
    () => queuedMessages.filter(message => message.status === 'queued').map(message => message.id),
    [queuedMessages]
  )
  const displayedQueuedMessages = useMemo(
    () =>
      [...queuedMessages].sort(
        (left, right) =>
          queuedMessageDisplayPriority(left.status) - queuedMessageDisplayPriority(right.status)
      ),
    [queuedMessages]
  )
  const activeMessage = queuedMessages.find(message => message.id === activeMessageId) ?? null
  const failedCount = [...queuedMessages, ...guidanceMessages].filter(
    message => message.status === 'failed' || message.status === 'expired'
  ).length
  const unknownCount = [...queuedMessages, ...guidanceMessages].filter(
    message => message.status === 'unknown'
  ).length
  const needsAttention = queuePaused || failedCount > 0 || unknownCount > 0
  const queueStatusText = [
    ...(unknownCount > 0
      ? [t('composer_status.queue_unknown', { count: unknownCount })]
      : []),
    ...(failedCount > 0
      ? [
          t('composer_status.queue_failures', { count: failedCount }),
        ]
      : []),
  ].join(' · ')
  const queueSummary = queuePaused ? t('queue.paused') : undefined

  if (!hasMessages || (sendingOnly && shownOwnerKey !== ownerKey)) {
    return null
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveMessageId(String(active.id))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      onReorderQueuedMessages?.(String(active.id), String(over.id))
    }
    setActiveMessageId(null)
  }

  const panel = (
    <div
      data-testid="conversation-queue-panel"
      className={
        presentation
          ? 'min-w-0'
          : 'mb-1 rounded-[18px] border border-border bg-base px-2 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.05)]'
      }
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActiveMessageId(null)}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={queuedMessageIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col">
            {queuePaused && queuedMessages.length > 0 && (
              <div className="flex h-8 items-center justify-between gap-2 px-2 text-xs text-text-muted">
                <span>{t('queue.paused')}</span>
                <button
                  type="button"
                  data-testid="resume-queue-button"
                  onClick={onResumeQueue}
                  className="h-8 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {t('queue.resume')}
                </button>
              </div>
            )}
            {guidanceMessages.map(message => (
              <QueueRow
                key={message.id}
                id={message.id}
                content={message.content}
                status={message.status}
                error={message.error}
                mode="guidance"
                onCancel={onCancelGuidanceMessage}
                onInterrupt={onInterruptAndSendQueuedMessage}
              />
            ))}
            {displayedQueuedMessages.map(message => (
              <QueueRow
                key={message.id}
                id={message.id}
                content={message.content || message.attachments?.map(file => file.filename).join(', ') || ''}
                status={message.status}
                error={message.error}
                notice={message.notice}
                cancelRequested={message.cancelRequested}
                deliveryMode={message.deliveryMode}
                mode="queue"
                onGuide={onSendQueuedAsGuidance}
                onInterrupt={onInterruptAndSendQueuedMessage}
                onEdit={onEditQueuedMessage}
                canReorder={message.status === 'queued' && queuedMessageIds.length > 1}
                onCancel={onCancelQueuedMessage}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeMessage && <QueueDragPreview content={activeMessage.content || activeMessage.attachments?.map(file => file.filename).join(', ') || ''} />}
        </DragOverlay>
      </DndContext>
    </div>
  )

  if (presentation === 'detail') return panel
  if (presentation === 'embedded') {
    return (
      <ComposerStatusItem
        id="queue"
        title={t('composer_status.queue', 'Message queue')}
        statusText={queueStatusText || undefined}
        summary={queueSummary}
        count={queuedMessages.length + guidanceMessages.length}
        icon={MessagesSquare}
        attention={needsAttention}
      >
        {panel}
      </ComposerStatusItem>
    )
  }

  return panel
}

function queuedMessageDisplayPriority(status: QueuedWorkbenchMessage['status']): number {
  if (['sending', 'accepted', 'running', 'unknown'].includes(status)) return 0
  if (status === 'queued') return 1
  return 2
}

interface QueueRowProps {
  id: string
  content: string
  status: QueuedWorkbenchMessage['status'] | GuidanceWorkbenchMessage['status']
  error?: string
  notice?: string
  cancelRequested?: boolean
  deliveryMode?: 'guidance'
  mode: 'queue' | 'guidance'
  onGuide?: (id: string) => void
  onEdit?: (id: string) => void
  onInterrupt?: (id: string) => void
  canReorder?: boolean
  onCancel?: (id: string, action?: 'cancel' | 'dismiss') => void
}

function QueueRow({
  id,
  content,
  status,
  error,
  notice,
  cancelRequested = false,
  deliveryMode,
  mode,
  onGuide,
  onEdit,
  onInterrupt,
  canReorder = false,
  onCancel,
}: QueueRowProps) {
  const { t } = useTranslation('common')
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canReorder })
  const cancelSupported = canCancelInput({ status, deliveryMode })
  const isBusy = status === 'sending'
  const isSendingGuidance = isBusy && notice === '正在引导当前对话'
  const localPending = status === 'queued' || status === 'failed'
  const showInlineInterrupt = mode === 'guidance' || localPending || isSendingGuidance
  const statusText = cancelRequested && cancelSupported
    ? t('input_delivery.cancelling')
    : isSendingGuidance ? '引导中' : status === 'queued' || status === 'unknown' ? t(`input_delivery.${status}`) : error ?? notice ?? t(`input_delivery.${status}`)

  return (
    <div
      ref={setNodeRef}
      data-testid={`conversation-queue-row-${id}`}
      data-status={status}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        'flex min-h-8 items-center gap-2 rounded-xl px-2 text-sm text-text-secondary hover:bg-surface',
        isDragging ? 'opacity-30' : '',
      ].join(' ')}
    >
      {canReorder && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          data-testid={`queue-drag-handle-${id}`}
          {...attributes}
          {...listeners}
          className="flex h-8 w-4 shrink-0 touch-none cursor-grab items-center justify-center rounded text-text-muted hover:bg-muted active:cursor-grabbing"
          aria-label="拖拽调整消息顺序"
          title="拖拽调整消息顺序"
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="truncate text-text-secondary" title={content}>{content}</span>
        {statusText && (
          <span
            title={statusText}
            className={[
              'max-w-[14rem] shrink-0 truncate text-xs',
              status === 'failed'
                ? 'text-destructive'
                : status === 'unknown'
                  ? 'text-warning'
                  : 'text-text-muted',
            ].join(' ')}
          >
            {statusText}
          </span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {mode === 'queue' && localPending && !cancelRequested && !isSendingGuidance && (
          <button
            type="button"
            data-testid={`queue-guidance-button-${id}`}
            onClick={() => onGuide?.(id)}
            disabled={isBusy}
            className="flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-lg px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0"
            aria-label="作为引导发送"
          >
            <CornerDownRight className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">引导</span>
          </button>
        )}
        {showInlineInterrupt && !cancelRequested && (
          <button
            type="button"
            data-testid={`queue-interrupt-button-${id}`}
            onClick={() => onInterrupt?.(id)}
            className="flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary sm:h-8 sm:min-w-0"
            aria-label={t('workbench.interrupt_and_send')}
          >
            <Zap className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('workbench.interrupt_and_send_short')}</span>
          </button>
        )}
        {!isSendingGuidance && (
          <button
            type="button"
            data-testid={`queue-cancel-button-${id}`}
            onClick={() => onCancel?.(id, 'cancel')}
            disabled={cancelRequested || !cancelSupported}
            title={!cancelSupported ? t('input_delivery.guidance_withdraw_unavailable') : undefined}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:min-w-0 sm:px-2"
            aria-label={t(cancelSupported ? 'input_delivery.cancel' : 'input_delivery.guidance_withdraw_unavailable')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {mode === 'queue' && localPending && !cancelRequested && !isBusy && (
          <ActionMenu
            ariaLabel="更多队列操作"
            testId={`queue-more-button-${id}`}
            icon={MoreHorizontal}
            triggerClassName="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-secondary sm:h-8 sm:min-w-0 sm:px-2"
            items={[
              {
                label: '编辑',
                icon: Pencil,
                testId: `queue-edit-button-${id}`,
                onSelect: () => onEdit?.(id),
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}

function QueueDragPreview({ content }: { content: string }) {
  return (
    <div
      data-testid="queue-drag-overlay"
      className="flex min-h-8 max-w-[28rem] items-center gap-2 rounded-xl border border-border bg-base px-3 text-sm text-text-secondary shadow-lg"
    >
      <GripVertical className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="truncate">{content}</span>
    </div>
  )
}
