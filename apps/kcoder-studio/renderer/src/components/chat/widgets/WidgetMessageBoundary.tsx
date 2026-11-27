import { useTranslation } from '@/hooks/useTranslation'
import { useContext, type ReactNode } from 'react'
import {
  ConversationWidgetsContext,
  WidgetMessageContext,
  widgetBelongsToMessage,
  type WidgetMessageIdentity,
} from './widgetContext'
import {
  CommittedWidgetPreview,
  ConversationWidget,
  DeferredWidgetNotice,
} from './ConversationWidget'
import { splitWidgetDirectives } from './widgetDirectives'

export function WidgetMessageBoundary({
  identity,
  children,
}: {
  identity: WidgetMessageIdentity
  children: ReactNode
}) {
  return <WidgetMessageContext.Provider value={identity}>{children}</WidgetMessageContext.Provider>
}

export function WidgetMessageArtifacts({
  content = '',
  preview = false,
  expected = false,
  toolCallId,
  excludedToolIds,
}: {
  content?: string
  preview?: boolean
  expected?: boolean
  toolCallId?: string
  excludedToolIds?: string[]
}) {
  const { t } = useTranslation('chat')
  const context = useContext(ConversationWidgetsContext)
  const message = useContext(WidgetMessageContext)
  if (!context || context.invalidated || message.ownsWidgets === false || (!preview && !message.terminal)) return null
  const mentioned = new Set(
    splitWidgetDirectives(content).flatMap(part =>
      part.kind === 'widget' ? [part.reference.widgetId] : []
    )
  )
  const candidates = context.references.filter(
    widget =>
      widgetBelongsToMessage(widget, message) &&
      !mentioned.has(widget.widgetId) &&
      (!preview ||
        (toolCallId
          ? widget.toolCallId === toolCallId
          : !excludedToolIds?.includes(widget.toolCallId)))
  )
  if (
    !message.attemptId &&
    message.subtaskId == null &&
    new Set(candidates.map(widget => widget.attemptId)).size > 1
  )
    return null
  const latest = [
    ...new Map(
      candidates.sort((a, b) => a.revision - b.revision).map(widget => [widget.widgetId, widget])
    ).values(),
  ]
  if (!preview && expected && !mentioned.size && !latest.length)
    return (
      <div
        role="status"
        className="studio-card-spacing my-3 rounded-lg border border-border text-sm text-text-muted"
      >
        <p>
          {t(context.listingStatus === 'unrequested' ? 'widgets.loading' : 'widgets.unavailable')}
        </p>
        {context.listingStatus !== 'unrequested' && (
          <button
            className="mt-2 rounded-md border border-border px-2 py-1"
            onClick={context.reload}
          >
            {t('widgets.retry')}
          </button>
        )}
      </div>
    )
  const inputs = preview
    ? context.previews.filter(
        item =>
          widgetBelongsToMessage(item, message) &&
          (toolCallId
            ? item.toolCallId === toolCallId
            : !excludedToolIds?.includes(item.toolCallId)) &&
          !latest.some(
            widget => widget.toolCallId === item.toolCallId && widget.attemptId === item.attemptId
          )
      )
    : []
  return (
    <>
      {inputs.map(input => (
        <DeferredWidgetNotice
          key={`${input.attemptId}:${input.toolCallId}`}
          title={input.title ?? t('widgets.title')}
        />
      ))}
      {latest.map(widget =>
        preview ? (
          <CommittedWidgetPreview key={`${widget.widgetId}:${widget.revision}`} widget={widget} />
        ) : (
          <ConversationWidget key={`${widget.widgetId}:${widget.revision}`} reference={widget} />
        )
      )}
    </>
  )
}
