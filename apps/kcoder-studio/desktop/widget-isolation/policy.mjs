export const NATIVE_WIDGET_LIMITS = Object.freeze({
  totalFrames: 6, parentFrames: 3, residentKiB: 256 * 1024,
  heartbeatMs: 2500, startupMs: 5000, sampleMs: 100,
  verificationStartupMs: 2500,
  domNodes: 4000, canvasPixels: 4 * 1024 * 1024,
  messagesPerSecond: 40,
})

export function inspectNativeWidgetIsolation({ app, contents, platform, verifiedPlatforms = [], electronVersion, chromiumVersion }) {
  if (!verifiedPlatforms.includes(platform)) return { enabled: false, reason: 'native platform isolation has not been verified' }
  if (electronVersion !== '42.3.3' || !chromiumVersion.startsWith('148.')) return { enabled: false, reason: 'native runtime version has not been verified' }
  if (['no-sandbox', 'disable-setuid-sandbox', 'disable-web-security'].some(flag => app.commandLine.hasSwitch(flag))) return { enabled: false, reason: 'native process sandbox is disabled' }
  if (!app.commandLine.getSwitchValue('enable-features').split(',').includes('IsolateSandboxedIframes:grouping/per-document') || app.commandLine.getSwitchValue('disable-features').split(',').some(feature => feature.startsWith('IsolateSandboxedIframes'))) return { enabled: false, reason: 'per-document renderer isolation is not configured' }
  const preferences = contents.getLastWebPreferences()
  if (!preferences.sandbox || !preferences.contextIsolation || !preferences.webSecurity || preferences.nodeIntegration || preferences.nodeIntegrationInSubFrames || preferences.webviewTag) return { enabled: false, reason: 'native renderer security preferences are incompatible' }
  return { enabled: true }
}

export function verifyNativeWidgetFrame({ frame, parent, origin, frameName, usedProcessIds = new Set() }) {
  if (!frame || frame.isDestroyed() || frame.name !== frameName || !frameName.startsWith('kcoder-widget-')) throw new Error('resource_blocked: owned widget frame is unavailable')
  if (frame.origin !== 'null') throw new Error('resource_blocked: widget frame must have an opaque sandbox origin')
  const url = new URL(frame.url)
  if (url.origin !== origin || !/^\/(?:[A-Za-z0-9_-]+\/)*(?:api\/widgets|widget-sandbox)\/isolated-v1\.html$/.test(url.pathname)) throw new Error('resource_blocked: widget frame document does not match its owner')
  if (!Number.isInteger(frame.processId) || frame.processId === parent.mainFrame.processId || !Number.isInteger(frame.osProcessId) || frame.osProcessId <= 0 || frame.osProcessId === parent.getOSProcessId()) throw new Error('resource_blocked: widget shares its parent renderer process')
  if (usedProcessIds.has(frame.osProcessId)) throw new Error('resource_blocked: widget renderer process is already owned by another component')
  return { processId: frame.processId, osProcessId: frame.osProcessId, routingId: frame.routingId }
}

export function widgetResourceViolation(entry, now, metrics) {
  if (!entry.ready && now - entry.createdAt > (entry.startupBudgetMs ?? NATIVE_WIDGET_LIMITS.startupMs)) return 'component did not become ready'
  if (now - (entry.lastHeartbeat ?? entry.createdAt) > (entry.lastHeartbeat ? NATIVE_WIDGET_LIMITS.heartbeatMs : NATIVE_WIDGET_LIMITS.startupMs)) return 'component stopped responding'
  if (metrics && metrics.memory.workingSetSize > NATIVE_WIDGET_LIMITS.residentKiB) return 'component exceeded its renderer memory budget'
  if (entry.domNodes > NATIVE_WIDGET_LIMITS.domNodes) return 'component exceeded its DOM budget'
  if (entry.canvasPixels > NATIVE_WIDGET_LIMITS.canvasPixels) return 'component exceeded its canvas budget'
  return null
}
