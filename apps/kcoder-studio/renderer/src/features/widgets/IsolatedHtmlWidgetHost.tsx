import { useCallback } from 'react'
import { WidgetDocumentHost, type InlineWidgetHostProps, type WidgetFrameLease } from './InlineWidgetHost'

interface NativeWidgetLease { leaseId: string; widgetId: string; revision: number; processSeparated: boolean }
interface NativeWidgetBridge {
  getCapabilities: () => Promise<{ isolatedHtml: boolean }>
  authorize: (request: { widgetId: string; revision: number; frameName: string; panelId: string; verificationOnly?: boolean }) => Promise<NativeWidgetLease>
  heartbeat: (request: { leaseId: string; widgetId: string; revision: number; domNodes: number; canvasPixels: number; ready: boolean }) => Promise<unknown>
  revoke: (request: { leaseId: string }) => Promise<unknown>
  onRevoked: (callback: (value: { leaseId: string; widgetId: string; revision: number; reason: string }) => void) => () => void
}

function nativeWidgetBridge(): NativeWidgetBridge | undefined {
  const host = (window as Window & { kcoderDesktopHost?: { widgets?: NativeWidgetBridge } }).kcoderDesktopHost?.widgets
  return host && ['getCapabilities', 'authorize', 'heartbeat', 'revoke', 'onRevoked'].every(key => typeof host[key as keyof NativeWidgetBridge] === 'function') ? host : undefined
}

/** The native owner must prove process isolation before any generated script is sent. */
export function IsolatedHtmlWidgetHost(props: InlineWidgetHostProps) {
  const bridge = nativeWidgetBridge()
  const authorize = useCallback(async (_frame: HTMLIFrameElement, reference: InlineWidgetHostProps['widget'], frameName: string): Promise<WidgetFrameLease> => {
    if (!bridge || !(await bridge.getCapabilities()).isolatedHtml) throw new Error('resource_blocked: native JavaScript isolation is not available on this host')
    const lease = await bridge.authorize({ widgetId: reference.widgetId, revision: reference.revision, frameName, panelId: props.panelId, verificationOnly: props.verificationOnly === true })
    if (!lease.processSeparated || lease.widgetId !== reference.widgetId || lease.revision !== reference.revision || typeof lease.leaseId !== 'string') throw new Error('resource_blocked: native widget process authorization failed')
    let pendingHeartbeat = false
    return {
      release: () => bridge.revoke({ leaseId: lease.leaseId }),
      heartbeat: async metrics => {
        if (pendingHeartbeat) return
        pendingHeartbeat = true
        try { await bridge.heartbeat({ leaseId: lease.leaseId, widgetId: reference.widgetId, revision: reference.revision, ...metrics }) }
        finally { pendingHeartbeat = false }
      },
      onRevoked: callback => bridge.onRevoked(value => {
        if (value.leaseId === lease.leaseId && value.widgetId === reference.widgetId && value.revision === reference.revision && typeof value.reason === 'string') callback(value.reason.slice(0, 2048))
      }),
    }
  }, [bridge, props.panelId, props.verificationOnly])
  const documentUrl = (props.sandboxDocumentUrl ?? '/api/widgets/sandbox-v1.html').replace(/(?:sandbox-v1|host-v1)\.html$/, 'isolated-v1.html')
  return <WidgetDocumentHost {...props} key={`${props.panelId}:${props.widget.widgetId}:${props.widget.revision}:${props.widget.sha256}:${Boolean(props.verificationOnly)}`} sandboxDocumentUrl={documentUrl} documentMode={bridge ? 'isolated_html' : 'managed'} authorizeFrame={authorize} />
}
