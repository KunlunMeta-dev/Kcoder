import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  InlineWidgetHost,
  readWidgetTheme,
  type InlineWidgetHostProps,
  type WidgetAppMessageContext,
} from '@/features/widgets'
import { useTranslation } from '@/hooks/useTranslation'
import type { WidgetRef } from '../../../../../shared/generated/contracts'
import { ConversationWidgetsContext } from './widgetContext'
import { createMcpAppDispatcher, type McpAppDispatcher } from './mcpAppDispatcher'

/** Retained Apps share the conversation renderer; only this adapter receives MCP RPC. */
export function McpAppWidget(props: InlineWidgetHostProps) {
  const context = useContext(ConversationWidgetsContext)
  const { t, i18n } = useTranslation('chat')
  const [draftRequest, setDraftRequest] = useState<string>()
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null)
  const requestDraft = useCallback(
    (text: string) =>
      new Promise<void>((resolve, reject) => {
        if (pending.current) {
          reject(new Error('Another App draft request is awaiting the user'))
          return
        }
        pending.current = { resolve, reject }
        setDraftRequest(text)
      }),
    []
  )
  const api = context?.mcpApps
  const isCurrent = context?.isCurrent
  const widget = props.widget as WidgetRef
  const dispatcher = useRef<McpAppDispatcher | undefined>(undefined)
  useEffect(() => {
    if (!api || !isCurrent) return
    const owner = createMcpAppDispatcher({
      widget,
      api,
      isCurrent,
      theme: () => readWidgetTheme(i18n.language),
      requestDraft,
    })
    dispatcher.current = owner
    return () => {
      pending.current?.reject(new Error('App view closed'))
      pending.current = null
      owner.dispose()
      if (dispatcher.current === owner) dispatcher.current = undefined
    }
  }, [api, isCurrent, widget, requestDraft, i18n])
  useEffect(() => {
    dispatcher.current?.updateContext()
  }, [i18n.language])
  useEffect(() => {
    const update = () => dispatcher.current?.updateContext()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    })
    return () => observer.disconnect()
  }, [])
  const receive = useCallback(
    (message: WidgetAppMessageContext) => dispatcher.current?.receive(message),
    []
  )
  const settle = (accepted: boolean) => {
    const request = pending.current
    if (!request) return
    pending.current = null
    if (accepted && draftRequest && context && !context.invalidated && context.isCurrent()) {
      context.sendPrompt(draftRequest)
      request.resolve()
    } else request.reject(new Error('The user cancelled the App draft request'))
    setDraftRequest(undefined)
  }
  return (
    <>
      <InlineWidgetHost {...props} onAppMessage={receive} />
      {draftRequest && (
        <div
          role="group"
          aria-label={t('widgets.appDraftRequest')}
          className="my-2 rounded-xl border border-border bg-surface px-3 py-3 text-sm"
        >
          <p className="mb-2 font-medium">{t('widgets.appDraftRequest')}</p>
          <p className="mb-3 max-h-28 overflow-y-auto whitespace-pre-wrap text-text-muted">
            {draftRequest}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1"
              onClick={() => settle(true)}
            >
              {t('widgets.appAddToDraft')}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1 text-text-muted"
              onClick={() => settle(false)}
            >
              {t('widgets.appCancel')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
