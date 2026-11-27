import { useContext, useEffect, useRef, useState } from 'react'
import { InlineWidgetHost, isolatedHtmlWidgetRenderer } from '@/features/widgets'
import { widgetRenderErrorCode } from '@/features/widgets/bridge'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import { ConversationWidgetsContext, WidgetMessageContext } from './widgetContext'

/** A visible process row may verify a committed first frame without enabling actions. */
export function WidgetFirstFrameProbe({ widget }: { widget: WidgetRef }) {
  const context = useContext(ConversationWidgetsContext)
  const message = useContext(WidgetMessageContext)
  const [probing, setProbing] = useState(false)
  const settled = useRef(false)
  const activeProbeIdentity = useRef<string | undefined>(undefined)
  const eligible = Boolean(
    context &&
    !context.invalidated &&
    message.active === true &&
    !message.terminal &&
    !widget.mcpApp
  )
  const probeWidget = useRef(widget)
  useEffect(() => {
    probeWidget.current = widget
  }, [widget])
  const identity = `${widget.widgetId}:${widget.revision}:${widget.sha256}`
  const claim = context?.claimProbe
  const isCurrent = context?.isCurrent
  useEffect(() => {
    if (!eligible || !claim || !isCurrent?.() || !claim(probeWidget.current)) return
    settled.current = false
    activeProbeIdentity.current = identity
    setProbing(true)
    // No receipt means unconfirmed. Timeout/offscreen must never become a false pass.
    const timer = setTimeout(() => { settled.current = true; setProbing(false) }, 3000)
    return () => { settled.current = true; clearTimeout(timer) }
  }, [eligible, claim, isCurrent, identity])
  if (!eligible || !probing || !context?.isCurrent()) return null
  return (
    <div
      data-testid="widget-first-frame-probe"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 [&_[data-testid=inline-widget-frame]]:absolute [&_[data-testid=inline-widget-frame]]:left-0 [&_[data-testid=inline-widget-frame]]:top-0"
    >
      <InlineWidgetHost
        widget={widget}
        panelId={`${context.hostPanelId}:probe`}
        verificationOnly
        isolatedHtmlHost={isolatedHtmlWidgetRenderer}
        loadContent={(reference, signal) => context.api.content(reference as WidgetRef, signal)}
        onFeedback={feedback => {
          if (settled.current || activeProbeIdentity.current !== identity || !context.isCurrent() || context.invalidated) return
          settled.current = true
          setProbing(false)
          if (feedback.status === 'unconfirmed') return
          void context.api
            .receipt(
              widget,
              feedback.status === 'ready' ? 'rendered' : 'failed',
              feedback.status === 'error' ? widgetRenderErrorCode(feedback.message) : undefined
            )
            .catch(() => {
              // A lost receipt is unconfirmed and never blindly resent.
            })
        }}
      />
    </div>
  )
}
