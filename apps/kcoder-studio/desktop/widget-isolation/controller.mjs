import { randomUUID } from 'node:crypto'
import { inspectNativeWidgetIsolation, verifyNativeWidgetFrame, widgetResourceViolation, NATIVE_WIDGET_LIMITS } from './policy.mjs'

/** Must run before app readiness; other explicitly selected Chromium features are retained. */
export function configureWidgetProcessIsolation(app) {
  const current = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean)
  const retained = current.filter(feature => !feature.startsWith('IsolateSandboxedIframes'))
  app.commandLine.appendSwitch('enable-features', [...retained, 'IsolateSandboxedIframes:grouping/per-document'].join(','))
}

/** Owns only separately verified widget renderer processes, never the parent renderer. */
export function createNativeWidgetIsolationController({ app, ipcMain, getWindow, getGatewayOrigin, verifiedPlatforms = [], now = Date.now, terminateProcess = pid => process.kill(pid, 'SIGKILL'), runtimeVersions = process.versions, platform = process.platform }) {
  const owners = new Map()
  const contentsListeners = new Map()
  const sessions = new Map()
  const channels = ['capabilities', 'authorize', 'heartbeat', 'revoke'].map(action => `kcoder:widgets:${action}`)
  let disposed = false

  const trustedParent = event => {
    const window = getWindow(event.sender)
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('Widget control is restricted to its Studio main frame')
    const origin = getGatewayOrigin()
    if (new URL(event.sender.mainFrame.url).origin !== origin) throw new Error('Widget control origin is no longer trusted')
    return { window, contents: event.sender, origin }
  }
  const capability = contents => inspectNativeWidgetIsolation({ app, contents, platform, verifiedPlatforms, electronVersion: runtimeVersions.electron || '', chromiumVersion: runtimeVersions.chrome || '' })
  const peerProcessIds = (contents, frame) => {
    const ids = new Set()
    for (const entry of owners.values()) {
      if (entry.frame !== frame && !entry.frame.isDestroyed()) ids.add(entry.frame.osProcessId)
      if (entry.contents !== contents && !entry.contents.isDestroyed()) ids.add(entry.contents.getOSProcessId())
    }
    for (const peer of contents.mainFrame.framesInSubtree) if (peer !== frame && !peer.isDestroyed()) ids.add(peer.osProcessId)
    return ids
  }
  const identityIsCurrent = entry => {
    try {
      if (entry.contents.isDestroyed() || new URL(entry.contents.mainFrame.url).origin !== entry.origin) return false
      const identity = verifyNativeWidgetFrame({ frame: entry.frame, parent: entry.contents, origin: entry.origin, frameName: entry.frameName, usedProcessIds: peerProcessIds(entry.contents, entry.frame) })
      return identity.processId === entry.processId && identity.osProcessId === entry.osProcessId && identity.routingId === entry.routingId
    } catch { return false }
  }
  const ownedFrame = frame => {
    try {
      for (let current = frame; current; current = current.parent) {
        for (const entry of owners.values()) if (entry.frame === current) return entry
      }
    } catch { /* A detached frame no longer owns a live channel. */ }
    return undefined
  }

  const revoke = (leaseId, reason, terminate = true) => {
    const entry = owners.get(leaseId)
    if (!entry) return false
    owners.delete(leaseId)
    // Process IDs are rechecked against the live native frame immediately before termination.
    try {
      const sharesPeerProcess = peerProcessIds(entry.contents, entry.frame).has(entry.osProcessId)
      if (terminate && !sharesPeerProcess && !entry.frame.isDestroyed() && entry.frame.osProcessId === entry.osProcessId &&
        entry.frame.processId === entry.processId && entry.frame.routingId === entry.routingId && entry.contents.getOSProcessId() !== entry.osProcessId) terminateProcess(entry.osProcessId)
    } catch (error) {
      if (error.code !== 'ESRCH') entry.terminationError = String(error.message)
    }
    if (!entry.contents.isDestroyed()) entry.contents.send('kcoder:widgets:revoked', {
      leaseId, widgetId: entry.widgetId, revision: entry.revision, reason,
      ...(entry.terminationError ? { terminationError: entry.terminationError } : {}),
    })
    return true
  }

  const attach = contents => {
    if (contentsListeners.has(contents.id)) return
    const navigation = event => { if (ownedFrame(event.frame)) event.preventDefault() }
    const ownerNavigation = event => {
      if (event.isMainFrame && !event.isSameDocument) {
        for (const entry of [...owners.values()]) if (entry.contents === contents) revoke(entry.leaseId, 'Studio owner navigated')
      }
    }
    const crashed = () => {
      for (const entry of [...owners.values()]) if (entry.contents === contents) revoke(entry.leaseId, 'Studio owner renderer closed')
    }
    const destroyed = () => {
      for (const entry of [...owners.values()]) if (entry.contents === contents) revoke(entry.leaseId, 'Studio owner closed')
      contentsListeners.delete(contents.id)
    }
    contents.on('will-frame-navigate', navigation)
    contents.on('did-start-navigation', ownerNavigation)
    contents.on('render-process-gone', crashed)
    contents.once('destroyed', destroyed)
    contentsListeners.set(contents.id, { contents, navigation, ownerNavigation, crashed, destroyed })
    const session = contents.session
    if (!sessions.has(session)) {
      const filter = (details, callback) => callback({ cancel: Boolean(ownedFrame(details.frame)) })
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, filter)
      sessions.set(session, filter)
    }
  }

  ipcMain.handle(channels[0], event => {
    const { contents } = trustedParent(event)
    return { isolatedHtml: capability(contents).enabled, limits: NATIVE_WIDGET_LIMITS }
  })
  ipcMain.handle(channels[1], (event, request) => {
    if (disposed) throw new Error('Widget host is closed')
    const { contents, origin } = trustedParent(event)
    const available = capability(contents)
    if (!available.enabled) throw new Error(`resource_blocked: ${available.reason}`)
    if (!request || typeof request !== 'object' || typeof request.widgetId !== 'string' || request.widgetId.length > 128 ||
      !Number.isSafeInteger(request.revision) || request.revision < 1 || typeof request.frameName !== 'string' ||
      !/^kcoder-widget-[a-zA-Z0-9-]{24,64}$/.test(request.frameName) || typeof request.panelId !== 'string' || request.panelId.length > 256 ||
      (request.verificationOnly !== undefined && typeof request.verificationOnly !== 'boolean')) throw new Error('Invalid widget frame ownership request')
    const panelCount = [...owners.values()].filter(entry => entry.contents === contents && entry.panelId === request.panelId).length
    if (owners.size >= NATIVE_WIDGET_LIMITS.totalFrames || panelCount >= NATIVE_WIDGET_LIMITS.parentFrames) throw new Error('widget_quota: native widget frame pool is full')
    const frame = contents.mainFrame.framesInSubtree.find(frame => frame.name === request.frameName)
    const usedProcessIds = peerProcessIds(contents, frame)
    // A single frame cannot acquire a second live lease under another artifact ID.
    for (const entry of owners.values()) if (entry.frame === frame) usedProcessIds.add(entry.osProcessId)
    const identity = verifyNativeWidgetFrame({ frame, parent: contents, origin, frameName: request.frameName, usedProcessIds })
    const memory = app.getAppMetrics().find(metric => metric.pid === identity.osProcessId)?.memory?.workingSetSize
    if (!Number.isFinite(memory) || memory <= 0) throw new Error('resource_blocked: native renderer memory metrics are unavailable')
    const leaseId = randomUUID()
    const entry = { leaseId, contents, frame, origin, frameName: request.frameName, ...identity, widgetId: request.widgetId, revision: request.revision, panelId: request.panelId, startupBudgetMs: request.verificationOnly ? NATIVE_WIDGET_LIMITS.verificationStartupMs : NATIVE_WIDGET_LIMITS.startupMs, createdAt: now(), lastHeartbeat: null, ready: false, domNodes: 0, canvasPixels: 0, messages: 0, messageWindow: now() }
    owners.set(leaseId, entry)
    attach(contents)
    return { leaseId, widgetId: entry.widgetId, revision: entry.revision, processSeparated: true }
  })
  ipcMain.handle(channels[2], (event, request) => {
    const { contents } = trustedParent(event)
    const entry = owners.get(request?.leaseId)
    if (!entry || entry.contents !== contents || request.widgetId !== entry.widgetId || request.revision !== entry.revision) throw new Error('Widget lease is no longer owned by this client')
    if (!identityIsCurrent(entry)) { revoke(entry.leaseId, 'component renderer identity changed'); return { revoked: true } }
    const current = now()
    if (current - entry.messageWindow >= 1000) { entry.messageWindow = current; entry.messages = 0 }
    entry.messages += 1
    if (entry.messages > NATIVE_WIDGET_LIMITS.messagesPerSecond) { revoke(entry.leaseId, 'component exceeded its message budget'); return { revoked: true } }
    if (![request.domNodes, request.canvasPixels].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid widget resource census')
    entry.lastHeartbeat = current
    entry.domNodes = request.domNodes
    entry.canvasPixels = request.canvasPixels
    entry.ready = request.ready === true
    const violation = widgetResourceViolation(entry, current)
    if (violation) revoke(entry.leaseId, violation)
    return { revoked: Boolean(violation) }
  })
  ipcMain.handle(channels[3], (event, request) => {
    const { contents } = trustedParent(event)
    const entry = owners.get(request?.leaseId)
    if (!entry || entry.contents !== contents) return { revoked: false }
    return { revoked: revoke(entry.leaseId, 'component closed') }
  })

  const timer = setInterval(() => {
    let metrics
    try { metrics = new Map(app.getAppMetrics().map(metric => [metric.pid, metric])) }
    catch { for (const leaseId of [...owners.keys()]) revoke(leaseId, 'native renderer metrics became unavailable'); return }
    for (const entry of [...owners.values()]) {
      try { if (entry.frame.isDestroyed()) { revoke(entry.leaseId, 'component renderer closed', false); continue } }
      catch { revoke(entry.leaseId, 'component renderer became unavailable', false); continue }
      if (!identityIsCurrent(entry)) { revoke(entry.leaseId, 'component renderer identity changed'); continue }
      const metric = metrics.get(entry.osProcessId)
      if (!Number.isFinite(metric?.memory?.workingSetSize) || metric.memory.workingSetSize <= 0) { revoke(entry.leaseId, 'native renderer metrics became unavailable'); continue }
      const violation = widgetResourceViolation(entry, now(), metric)
      if (violation) revoke(entry.leaseId, violation)
    }
  }, NATIVE_WIDGET_LIMITS.sampleMs)
  timer.unref?.()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      for (const leaseId of [...owners.keys()]) revoke(leaseId, 'native widget host closed')
      channels.forEach(channel => ipcMain.removeHandler(channel))
      for (const { contents, navigation, ownerNavigation, crashed, destroyed } of contentsListeners.values()) {
        if (!contents.isDestroyed()) {
          contents.removeListener('will-frame-navigate', navigation)
          contents.removeListener('did-start-navigation', ownerNavigation)
          contents.removeListener('render-process-gone', crashed)
          contents.removeListener('destroyed', destroyed)
        }
      }
      for (const session of sessions.keys()) session.webRequest.onBeforeRequest(null)
      contentsListeners.clear(); sessions.clear()
    },
    activeCount: () => owners.size,
  }
}
