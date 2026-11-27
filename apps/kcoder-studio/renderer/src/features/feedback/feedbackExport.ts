import { version } from '../../../package.json'
import { desktopHost } from '@/kcoder/desktopHost'
import { createRandomUuid } from '@/lib/random-id'

export interface FeedbackExportRequest {
  destination: null
  includeRuntimeLogs: boolean
  includeTaskInfo: boolean
  includeScreenshot: boolean
  includeSystemInfo: boolean
  note: string
  taskContext: unknown
  screenshotDataUrl: string | null
}

export interface FeedbackExportResult {
  reportId: string
  path: string
  downloadStatus: 'requested' | 'completed'
  warnings: string[]
}

const secretKey = /(?:authorization|cookie|password|passwd|apikey|token|secret|credentials?)$/i
const sensitiveKey = (key: string) => secretKey.test(key.replace(/[-_]/g, ''))

export function redactFeedbackText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&#](?:token|code|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/((?:"?(?:api[_-]?key|password|passwd|token|secret|client[_-]?secret)"?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
}

function safeJson(value: unknown): string {
  const text = JSON.stringify(value, (key, item) => sensitiveKey(key)
    ? '[redacted]' : typeof item === 'string' ? redactFeedbackText(item) : item, 2)
  if (text === undefined || new TextEncoder().encode(text).length > 1024 * 1024) {
    throw new Error('Feedback context exceeds 1 MiB')
  }
  return text
}

export function feedbackCapabilities() {
  const host = desktopHost()
  return { runtimeLogs: Boolean(host?.readFeedbackDiagnostics), screenshot: Boolean(host?.captureFeedbackScreenshot) }
}

export function captureFeedbackScreenshot(): Promise<string> {
  const host = desktopHost()
  if (!host?.captureFeedbackScreenshot) throw new Error('Feedback screenshot is unavailable')
  return host.captureFeedbackScreenshot()
}

export async function exportFeedbackBundle(request: FeedbackExportRequest): Promise<FeedbackExportResult | null> {
  if (!request || request.destination !== null || typeof request.note !== 'string' || request.note.length > 16384 ||
      ['includeRuntimeLogs', 'includeTaskInfo', 'includeScreenshot', 'includeSystemInfo'].some(key =>
        typeof request[key as keyof FeedbackExportRequest] !== 'boolean')) throw new Error('Invalid feedback request')
  const host = desktopHost()
  const { default: JSZip } = await import('jszip')
  const reportId = `KC-${createRandomUuid()}`
  const filename = `kcoder-feedback-${reportId}.zip`
  const zip = new JSZip()
  const warnings: string[] = [], included: string[] = []
  zip.file('report.md', `# KCoder feedback\n\nReport: ${reportId}\n\n${redactFeedbackText(request.note)}\n`)
  if (request.includeTaskInfo) {
    zip.file('context/task.json', safeJson(request.taskContext))
    included.push('taskInfo')
  }
  const diagnostics = host?.readFeedbackDiagnostics && (request.includeRuntimeLogs || request.includeSystemInfo)
    ? await host.readFeedbackDiagnostics({ runtimeLogs: request.includeRuntimeLogs, systemInfo: request.includeSystemInfo }) : null
  if (request.includeRuntimeLogs) {
    if (typeof diagnostics?.runtimeLogs === 'string' && diagnostics.runtimeLogs.length) {
      const bytes = new TextEncoder().encode(redactFeedbackText(diagnostics.runtimeLogs.slice(-1024 * 1024)))
      zip.file('logs/runtime.log', bytes.subarray(Math.max(0, bytes.length - 1024 * 1024)))
      included.push('runtimeLogs')
    } else warnings.push('RUNTIME_LOGS_UNAVAILABLE')
  }
  if (request.includeSystemInfo) {
    zip.file('environment.json', safeJson({ version, client: host ? 'electron' : 'browser',
      ...(diagnostics?.systemInfo ?? { userAgent: navigator.userAgent }) }))
    included.push('systemInfo')
  }
  if (request.includeScreenshot) {
    const image = request.screenshotDataUrl
    if (typeof image === 'string' && /^data:image\/png;base64,iVBORw0KGgo/.test(image) && image.length <= 12 * 1024 * 1024) {
      const png = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), char => char.charCodeAt(0))
      if (png.length > 8 * 1024 * 1024) throw new Error('Feedback screenshot exceeds 8 MiB')
      zip.file('screenshot.png', png)
      included.push('screenshot')
    } else warnings.push('SCREENSHOT_UNAVAILABLE')
  }
  zip.file('manifest.json', JSON.stringify({ schemaVersion: 1, reportId, createdAt: new Date().toISOString(),
    included, warnings, runtimeLogsLimitBytes: 1024 * 1024, redaction: 'credential keys, headers and URLs; screenshots are unchanged' }, null, 2))
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
  try {
    if (desktopHost() !== host) throw new Error('Feedback host changed')
    if (host?.download) {
      const outcome = await host.download({ url, filename })
      if (outcome.status === 'cancelled') return null
      if (outcome.status !== 'completed') throw new Error('Feedback download interrupted')
      return { reportId, path: filename, downloadStatus: 'completed', warnings }
    }
    const link = document.createElement('a')
    link.href = url; link.download = filename
    document.body.appendChild(link)
    try { link.click() } finally { link.remove() }
    return { reportId, path: filename, downloadStatus: 'requested', warnings }
  } finally {
    // Let browser downloads consume the URL; Electron has already settled its receipt.
    setTimeout(() => URL.revokeObjectURL(url), host?.download ? 0 : 1000)
  }
}
