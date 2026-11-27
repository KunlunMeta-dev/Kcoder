import { useContext, useEffect, useRef, useState } from 'react'
import { InlineWidgetHost } from '@/features/widgets/InlineWidgetHost'
import { isolatedHtmlWidgetRenderer } from '@/features/widgets'
import { widgetRenderErrorCode } from '@/features/widgets/bridge'
import { useTranslation } from '@/hooks/useTranslation'
import { ConversationWidgetsContext, WidgetMessageContext } from './widgetContext'
import type { WidgetDirective } from './widgetDirectives'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import { WidgetFirstFrameProbe } from './WidgetFirstFrameProbe'
import { McpAppWidget } from './McpAppWidget'
import { readWidgetUiState, writeWidgetUiState } from '@/kcoder/widgetUiState'

export function ConversationWidget({
  reference,
  duplicate = false,
  passive = false,
}: {
  reference: WidgetDirective
  duplicate?: boolean
  passive?: boolean
}) {
  const context = useContext(ConversationWidgetsContext)
  const message = useContext(WidgetMessageContext)
  const { t } = useTranslation('chat')
  const widget = context?.references.find(
    item => item.widgetId === reference.widgetId && item.revision === reference.revision
  )
  const [failed, setFailed] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [renderFailed, setRenderFailed] = useState(false)
  const api = context?.api
  const addReference = context?.addReference
  const invalidated = context?.invalidated
  const receipts = useRef(new Set<string>())
  const referenceKey = `${reference.widgetId}:${reference.revision}`
  useEffect(() => {
    if (!api || !addReference || invalidated || widget || duplicate || passive || !message.terminal)
      return
    const controller = new AbortController()
    api
      .read(reference.widgetId, reference.revision, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) addReference(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [
    api,
    addReference,
    invalidated,
    reference.widgetId,
    reference.revision,
    widget,
    duplicate,
    passive,
    message.terminal,
    retryGeneration,
  ])
  if (!context || context.invalidated || (failed && !widget))
    return (
      <div
        role="status"
        data-testid="widget-unavailable"
        className="my-3 rounded-xl border border-border px-3 py-3 text-sm text-text-muted"
      >
        <p>{t('widgets.unavailable')}</p>
        {context && !context.invalidated && (
          <button
            type="button"
            className="mt-2 rounded-md border border-border px-2 py-1 text-sm"
            onClick={() => {
              setFailed(false)
              setRetryGeneration(value => value + 1)
            }}
          >
            {t('widgets.retry')}
          </button>
        )}
      </div>
    )
  if (message.ownsWidgets === false) return null
  if (passive || !message.terminal) return <DeferredWidgetNotice widget={widget} />
  const id = `widget-${encodeURIComponent(context.key)}-${referenceKey}`
  if (duplicate)
    return (
      <button
        className="my-2 text-sm text-primary underline"
        onClick={() =>
          document.getElementById(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      >
        {t('widgets.viewExisting')}
      </button>
    )
  if (!widget)
    return (
      <p role="status" className="my-3 text-sm text-text-muted">
        {t('widgets.loading')}
      </p>
    )
  const Host = widget.mcpApp ? McpAppWidget : InlineWidgetHost
  return (
    <div id={id} data-scroll-anchor>
      <Host
        key={retryGeneration}
        widget={widget}
        isolatedHtmlHost={isolatedHtmlWidgetRenderer}
        panelId={context.hostPanelId}
        loadContent={(reference, signal) => context.api.content(reference as WidgetRef, signal)}
        visible={!context.invalidated}
        onSendPrompt={context.sendPrompt}
        initialState={
          context.isCurrent()
            ? readWidgetUiState(context.key, widget.widgetId, widget.revision, widget.sha256)
            : undefined
        }
        onState={state => {
          if (context.isCurrent())
            writeWidgetUiState(context.key, widget.widgetId, widget.revision, widget.sha256, state)
        }}
        onFeedback={feedback => {
          if (feedback.status === 'unconfirmed') { setRenderFailed(true); return }
          const status = feedback.status === 'ready' ? 'rendered' : 'failed'
          setRenderFailed(status === 'failed')
          const key = `${referenceKey}:${status}`
          if (receipts.current.has(key)) return
          receipts.current.add(key)
          void context.api
            .receipt(widget, status, feedback.status === 'error' ? widgetRenderErrorCode(feedback.message) : undefined)
            .catch(() => {
              // An unknown receipt is never automatically resent.
            })
        }}
      />
      {renderFailed && (
        <button
          type="button"
          className="mb-3 rounded-md border border-border px-3 py-1 text-sm"
          onClick={() => {
            setRenderFailed(false)
            setRetryGeneration(value => value + 1)
          }}
        >
          {t('widgets.retry')}
        </button>
      )}
    </div>
  )
}

export function CommittedWidgetPreview({ widget }: { widget: WidgetRef }) {
  return <DeferredWidgetNotice widget={widget} />
}

/** Process rows stay text-only; only the existing hidden probe can render before completion. */
export function DeferredWidgetNotice({ widget, title }: { widget?: WidgetRef; title?: string }) {
  const message = useContext(WidgetMessageContext)
  const { t } = useTranslation('chat')
  return (
    <div
      className="relative my-1 flex min-h-6 min-w-0 items-center gap-2 text-sm text-text-muted"
      role="status"
      data-testid="widget-deferred-status"
      title={widget?.summary || undefined}
    >
      <span className="truncate">{widget?.title || title || t('widgets.title')}</span>
      <span className="min-w-0 truncate">
        {t(
          message.terminal
            ? 'widgets.inFinalReply'
            : message.active === false
              ? 'widgets.incomplete'
              : 'widgets.afterCompletion'
        )}
      </span>
      {widget && message.active === true && <WidgetFirstFrameProbe widget={widget} />}
    </div>
  )
}
