import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { createRandomUuid } from '@/lib/random-id'
import { createWidgetRateLimiter, isBoundedWidgetJson, parseWidgetBridgeMessage } from './bridge'
import { widgetContentSha256 } from './contentHash'
import { widgetFramePool } from './framePool'
import { loadWidgetResources } from './resources'
import { readWidgetTheme } from './theme'
import { widgetStateCache } from './stateCache'
import {
  WIDGET_LIMITS,
  WIDGET_SANDBOX_DOCUMENT,
  type InlineWidgetReference,
  type WidgetFeedback,
  type WidgetJson,
  type WidgetTheme,
} from './types'

export interface InlineWidgetHostProps {
  widget: InlineWidgetReference
  panelId: string
  loadContent: (reference: InlineWidgetReference, signal: AbortSignal) => Promise<string>
  sandboxDocumentUrl?: string
  visible?: boolean
  theme?: WidgetTheme
  initialState?: WidgetJson
  /** Read-only first-frame probe; it never grants App calls or composer actions. */
  verificationOnly?: boolean
  onState?: (state: WidgetJson) => void
  onFeedback?: (feedback: WidgetFeedback) => void
  /** This only fills a visible composer draft; it never sends a turn itself. */
  onSendPrompt?: (text: string) => void
  /** Reserved for a separately verified process boundary; iframe alone is insufficient. */
  isolatedHtmlHost?: (props: InlineWidgetHostProps) => React.ReactNode
  /** Supplied only for an owner-validated MCP App resource; ordinary widgets have no RPC bridge. */
  onAppMessage?: (context: WidgetAppMessageContext) => void | Promise<void>
}

export interface WidgetAppMessageContext {
  message: Record<string, WidgetJson>
  widget: InlineWidgetReference
  reply: (message: Record<string, WidgetJson>) => void
  resize: (height: number, width?: number) => void
}

export interface WidgetFrameLease {
  release: () => void | Promise<unknown>
  heartbeat: (metrics: { domNodes: number; canvasPixels: number; ready: boolean }) => void | Promise<unknown>
  onRevoked: (callback: (reason: string) => void) => () => void
}

export interface WidgetDocumentHostProps extends InlineWidgetHostProps {
  documentMode?: 'managed' | 'isolated_html'
  authorizeFrame?: (frame: HTMLIFrameElement, widget: InlineWidgetReference, frameName: string) => Promise<WidgetFrameLease>
}

type Loaded = Awaited<ReturnType<typeof loadWidgetResources>> & { source: string }
const widgetKey = (widget: InlineWidgetReference) => `${widget.threadId}:${widget.widgetId}:${widget.revision}`
const releaseLease = (lease: WidgetFrameLease | null | undefined) => {
  try { void Promise.resolve(lease?.release()).catch(() => undefined) }
  catch { /* Native owner shutdown may precede the renderer cleanup. */ }
}

export function InlineWidgetHost(props: InlineWidgetHostProps) {
  const { widget, isolatedHtmlHost } = props
  if (widget.executionMode === 'isolated_html' && isolatedHtmlHost) return isolatedHtmlHost(props)
  return <WidgetDocumentHost {...props} key={`${props.panelId}:${widgetKey(widget)}:${widget.executionMode}:${widget.sha256}:${Boolean(props.verificationOnly)}`} />
}

export function WidgetDocumentHost({
  widget: suppliedWidget, panelId, loadContent, sandboxDocumentUrl = WIDGET_SANDBOX_DOCUMENT,
  visible = true, theme: suppliedTheme, initialState, onState, onFeedback, onSendPrompt, onAppMessage, verificationOnly = false,
  documentMode = 'managed', authorizeFrame,
}: WidgetDocumentHostProps) {
  const { t, i18n } = useTranslation('chat')
  const [widget] = useState(suppliedWidget)
  const loader = useRef(loadContent)
  const cacheKey = `${panelId}:${widgetKey(widget)}`
  const [owner] = useState(createRandomUuid)
  const [token] = useState(createRandomUuid)
  const container = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const initializedFrame = useRef<HTMLIFrameElement | null>(null)
  const nativeLease = useRef<WidgetFrameLease | null>(null)
  const renderFailed = useRef(false)
  const renderUnconfirmed = useRef(false)
  const frameRevoked = useRef(false)
  const lastPendingHeartbeat = useRef(0)
  const revokeSubscription = useRef<(() => void) | null>(null)
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver !== 'function')
  const [granted, setGranted] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'unconfirmed' | 'error'>('loading')
  const [error, setError] = useState('')
  const [height, setHeight] = useState<number>(320)
  const [closed, setClosed] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [verificationDone, setVerificationDone] = useState(false)
  const [observedTheme, setObservedTheme] = useState(() => readWidgetTheme(i18n.language))
  const theme = useMemo(() => ({ ...(suppliedTheme ?? { ...observedTheme, locale: i18n.language }), reducedMotion: false }), [suppliedTheme, observedTheme, i18n.language])
  const [initialControlState] = useState<WidgetJson>(() => initialState ?? widgetStateCache.get(cacheKey) ?? {})
  const state = useRef<WidgetJson>(initialControlState)
  const callbacks = useRef({ onState, onFeedback, onSendPrompt, onAppMessage })
  const mounted = visible && nearViewport && !closed && !revoked && !verificationDone && widget.executionMode === documentMode

  useEffect(() => { loader.current = loadContent }, [loadContent])
  useEffect(() => { callbacks.current = { onState, onFeedback, onSendPrompt, onAppMessage } }, [onState, onFeedback, onSendPrompt, onAppMessage])

  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(entries => setNearViewport(Boolean(entries[0]?.isIntersecting)), { rootMargin: '120px' })
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!mounted) return
    return widgetFramePool.acquire(owner, panelId, setGranted)
  }, [mounted, owner, panelId])

  useEffect(() => {
    if (!mounted || !granted) return
    return () => {
      revokeSubscription.current?.(); revokeSubscription.current = null
      const lease = nativeLease.current; nativeLease.current = null
      releaseLease(lease)
    }
  }, [mounted, granted])

  useEffect(() => {
    if (suppliedTheme) return
    const update = () => setObservedTheme(readWidgetTheme(i18n.language))
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    scheme?.addEventListener('change', update)
    return () => { observer.disconnect(); scheme?.removeEventListener('change', update) }
  }, [i18n.language, suppliedTheme])

  useEffect(() => {
    if (!mounted || !granted) return
    const controller = new AbortController()
    Promise.all([loader.current(widget, controller.signal), loadWidgetResources(widget.libraries)])
      .then(async ([source, resources]) => {
        const bytes = new TextEncoder().encode(source)
        if (bytes.byteLength > WIDGET_LIMITS.sourceBytes || bytes.byteLength !== widget.bytes) throw new Error('artifact_unavailable: widget content size mismatch')
        const sha256 = await widgetContentSha256(bytes)
        if (sha256 !== widget.sha256) throw new Error('artifact_unavailable: widget content hash mismatch')
        if (!controller.signal.aborted) setLoaded({ source, ...resources })
      }).catch(reason => {
        if (controller.signal.aborted) return
        const message = String(reason instanceof Error ? reason.message : reason).slice(0, 2048)
        renderFailed.current = true
        setError(message); setStatus('error')
        callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message })
        if (verificationOnly) setVerificationDone(true)
      })
    return () => controller.abort()
  }, [granted, mounted, widget, verificationOnly])

  useEffect(() => {
    if (!mounted || !granted) return
    const permit = createWidgetRateLimiter()
    const permitReply = createWidgetRateLimiter()
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || frameRevoked.current) return
      if (!permit()) {
        const message = 'widget_quota: component message rate exceeded'
        renderFailed.current = true; setError(message); setStatus('error'); setLoaded(undefined); setRevoked(true)
        callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message })
        return
      }
      const currentFrame = frame.current
      const lease = nativeLease.current
      const appMessage = event.data && typeof event.data === 'object' && event.data.jsonrpc === '2.0'
      if (appMessage && !verificationOnly && documentMode === 'isolated_html' && lease && callbacks.current.onAppMessage && !isBoundedWidgetJson(event.data, WIDGET_LIMITS.bridgeBytes)) {
        const id = event.data.id
        if ((typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isFinite(id)) || id === null) {
          currentFrame?.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Widget App request exceeds the 24 KiB inbound JSON budget' } }, '*')
        }
        const message = 'widget_quota: Widget App request exceeds its inbound JSON budget'
        renderFailed.current = true; setError(message); setStatus('error'); setRevoked(true)
        callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message })
        return
      }
      if (appMessage && !verificationOnly && documentMode === 'isolated_html' && lease && callbacks.current.onAppMessage &&
        isBoundedWidgetJson(event.data, WIDGET_LIMITS.bridgeBytes) && event.data !== null && !Array.isArray(event.data) && typeof event.data === 'object') {
        const reply = (message: Record<string, WidgetJson>) => {
          if (frame.current !== currentFrame || !currentFrame?.isConnected || nativeLease.current !== lease || !isBoundedWidgetJson(message, WIDGET_LIMITS.appHostOutboundBytes)) throw new Error('Widget App channel is unavailable or its message exceeds the 1 MiB outbound budget')
          if (!permitReply()) throw new Error('Widget App reply exceeds the 40 messages per second outbound budget')
          currentFrame.contentWindow?.postMessage(message, '*')
        }
        const id = event.data.id
        const failed = () => {
          if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return
          try { reply({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Widget App request could not be completed' } }) } catch { /* A revoked channel cannot receive a late response. */ }
        }
        const resize = (requestedHeight: number, requestedWidth?: number) => {
          if (frame.current !== currentFrame || !currentFrame?.isConnected || nativeLease.current !== lease || !Number.isFinite(requestedHeight) || (requestedWidth !== undefined && !Number.isFinite(requestedWidth))) throw new Error('Widget App resize channel is unavailable or its dimensions are invalid')
          // Width remains owned by the conversation/split-pane layout.
          setHeight(Math.max(WIDGET_LIMITS.minHeight, Math.ceil(requestedHeight)))
        }
        try { void Promise.resolve(callbacks.current.onAppMessage({ message: event.data, widget, reply, resize })).catch(failed) }
        catch { failed() }
        return
      }
      const message = parseWidgetBridgeMessage(event.data, { token, widgetId: widget.widgetId, revision: widget.revision })
      if (!message) return
      if (message.type === 'ready') {
        if (renderFailed.current || renderUnconfirmed.current) return
        renderUnconfirmed.current = false
        setStatus('ready')
        callbacks.current.onFeedback?.({ status: 'ready', widgetId: widget.widgetId, revision: widget.revision })
        if (verificationOnly) setVerificationDone(true)
      }
      if (message.type === 'unconfirmed' && !renderFailed.current) {
        renderUnconfirmed.current = true
        setStatus('unconfirmed')
        callbacks.current.onFeedback?.({ status: 'unconfirmed', widgetId: widget.widgetId, revision: widget.revision })
        if (verificationOnly) setVerificationDone(true)
      }
      if (message.type === 'resize') setHeight(Math.max(WIDGET_LIMITS.minHeight, Math.ceil(message.payload.height as number)))
      if (message.type === 'error') {
        renderFailed.current = true
        const error = message.payload.message as string
        setError(error); setStatus('error')
        callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message: error })
        if (verificationOnly) setVerificationDone(true)
      }
      if (message.type === 'state' && !verificationOnly) {
        state.current = message.payload.state as WidgetJson
        widgetStateCache.set(cacheKey, state.current)
        callbacks.current.onState?.(state.current)
      }
      if (message.type === 'sendPrompt' && !verificationOnly) callbacks.current.onSendPrompt?.(message.payload.text as string)
      if (message.type === 'heartbeat') {
        if (message.payload.ready === false) lastPendingHeartbeat.current = performance.now()
        void Promise.resolve(nativeLease.current?.heartbeat({ domNodes: message.payload.domNodes as number, canvasPixels: message.payload.canvasPixels as number, ready: message.payload.ready === true })).catch(() => undefined)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [granted, mounted, token, widget, cacheKey, documentMode, verificationOnly])

  useEffect(() => {
    if (status !== 'ready') return
    frame.current?.contentWindow?.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'theme', token, widgetId: widget.widgetId, revision: widget.revision, theme }, '*')
  }, [status, theme, token, widget.widgetId, widget.revision])

  const initializeFrame = () => {
    const current = frame.current
    if (!loaded || !current?.contentWindow || initializedFrame.current === current) return
    initializedFrame.current = current
    lastPendingHeartbeat.current = 0
    renderUnconfirmed.current = false
    frameRevoked.current = false
    const send = () => current.contentWindow?.postMessage({ protocol: 'kcoder-widget-host', version: 1, type: 'init', token,
      widgetId: widget.widgetId, revision: widget.revision, executionMode: widget.executionMode,
      title: widget.title, theme, state: state.current, ...loaded }, '*')
    if (documentMode === 'managed') { send(); return }
    if (!authorizeFrame) {
      const message = 'resource_blocked: verified execution authorization is unavailable'
      renderFailed.current = true; setError(message); setStatus('error'); setRevoked(true)
      callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message })
      return
    }
    void authorizeFrame(current, widget, current.name).then(lease => {
      if (frame.current !== current || !current.isConnected) { releaseLease(lease); return }
      nativeLease.current = lease
      revokeSubscription.current = lease.onRevoked(reason => {
        if (frame.current !== current || nativeLease.current !== lease) return
        frameRevoked.current = true
        if (reason === 'component did not become ready' && !renderFailed.current && lastPendingHeartbeat.current > 0 && performance.now() - lastPendingHeartbeat.current <= 600) {
          renderUnconfirmed.current = true
          setStatus('unconfirmed'); setRevoked(true)
          callbacks.current.onFeedback?.({ status: 'unconfirmed', widgetId: widget.widgetId, revision: widget.revision })
          if (verificationOnly) setVerificationDone(true)
          return
        }
        renderFailed.current = true
        setError(reason); setStatus('error'); setRevoked(true)
        callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message: reason })
      })
      send()
    }).catch(reason => {
      if (frame.current !== current) return
      const message = String(reason instanceof Error ? reason.message : reason).slice(0, 2048)
      renderFailed.current = true
      setError(message); setStatus('error'); setRevoked(true)
      callbacks.current.onFeedback?.({ status: 'error', widgetId: widget.widgetId, revision: widget.revision, message })
    })
  }
  const unsupported = widget.executionMode !== documentMode

  return (
    <div ref={container} data-testid="inline-widget" data-widget-id={widget.widgetId} data-widget-revision={widget.revision}
      inert={verificationOnly} aria-hidden={verificationOnly || undefined}
      data-widget-status={unsupported ? 'unsupported' : status} className="my-3 min-w-0 overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-2 text-sm text-muted-foreground">
        <span className="truncate">{widget.title}</span>
        <button type="button" className="shrink-0 rounded-md px-2 py-1 max-sm:min-h-11 max-sm:min-w-11 hover:bg-accent-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => setClosed(value => !value)} aria-expanded={!closed}>
          {closed ? t('widgets.show', { defaultValue: 'Show' }) : t('widgets.hide', { defaultValue: 'Hide' })}
        </button>
      </div>
      {unsupported ? <p className="px-3 pb-3 text-sm text-muted-foreground">{t('widgets.isolationRequired', { defaultValue: 'This component requires an enabled isolated execution host.' })}</p> : !closed && (
        <div data-testid="widget-frame-slot" className={verificationOnly ? undefined : 'relative'}
          style={!verificationOnly && status !== 'error' ? { height } : undefined}>
        {mounted && granted && loaded ? <iframe ref={frame} name={`kcoder-widget-${token}`} src={sandboxDocumentUrl} title={widget.title} sandbox="allow-scripts"
          referrerPolicy="no-referrer" tabIndex={verificationOnly ? -1 : undefined} onLoad={initializeFrame} style={{ height }} className={`block w-full border-0 bg-background${verificationOnly ? ' pointer-events-none' : ''}`}
          data-testid="inline-widget-frame" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'" /> :
          <p className="px-3 pb-3 text-sm text-muted-foreground">{widget.summary}</p>}
        {status === 'loading' && mounted && granted && <p className="absolute inset-x-0 bottom-0 bg-background px-3 pb-3 text-xs text-muted-foreground" role="status">{t('widgets.loading', { defaultValue: 'Preparing visualization…' })}</p>}
        {status === 'unconfirmed' && <p className="absolute inset-x-0 bottom-0 bg-background px-3 pb-3 text-xs text-muted-foreground" role="status">{t('widgets.unconfirmed', { defaultValue: 'Drawing is not confirmed. You can reload this visualization.' })}</p>}
        </div>
      )}
      {!closed && status === 'error' && <div className="px-3 pb-3 text-sm" role="alert"><p>{widget.summary}</p><p className="text-destructive">{t('widgets.renderFailed', { defaultValue: 'The visualization could not be displayed. Try reloading it.' })}</p><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('widgets.errorDetails', { defaultValue: 'Error details' })}</summary><p className="mt-1 break-words">{error}</p></details></div>}
    </div>
  )
}

export { WidgetStreamPreview } from './WidgetStreamPreview'
