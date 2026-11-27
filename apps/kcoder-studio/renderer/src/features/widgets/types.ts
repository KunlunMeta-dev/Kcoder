/** Only runtime-created references may be supplied to the widget host. */
export interface InlineWidgetReference {
  widgetId: string
  threadId: string
  turnId: string
  attemptId: string
  toolCallId: string
  revision: number
  title: string
  summary: string
  format: 'html' | 'svg'
  executionMode: 'managed' | 'isolated_html'
  libraries: string[]
  sha256: string
  bytes: number
  createdAtMs: number
}

export type WidgetJson = null | boolean | number | string | WidgetJson[] | { [key: string]: WidgetJson }

export interface WidgetTheme {
  colorScheme: 'light' | 'dark'
  foreground: string
  background: string
  muted: string
  border: string
  primary: string
  success: string
  destructive: string
  fontFamily: string
  fontSize: string
  locale: string
  reducedMotion: boolean
}

export type WidgetFeedback =
  | { status: 'ready'; widgetId: string; revision: number }
  | { status: 'unconfirmed'; widgetId: string; revision: number }
  | { status: 'error'; widgetId: string; revision: number; message: string }

export const WIDGET_LIMITS = Object.freeze({
  sourceBytes: 1024 * 1024,
  stateBytes: 16 * 1024,
  bridgeBytes: 24 * 1024,
  appHostOutboundBytes: 1024 * 1024,
  messagesPerSecond: 40,
  globalFrames: 6,
  panelFrames: 3,
  domNodes: 4000,
  chartPoints: 10000,
  minHeight: 120,
})

export const WIDGET_BRIDGE_VERSION = 1
export const WIDGET_SANDBOX_DOCUMENT = '/api/widgets/sandbox-v1.html'
