import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createNativeWidgetIsolationController, configureWidgetProcessIsolation } from './controller.mjs'

function fixture(options = {}) {
  const frame = { name: 'kcoder-widget-12345678-1234-1234-1234-123456789abc', origin: 'null', url: 'http://127.0.0.1:1234/api/widgets/isolated-v1.html', processId: 2, osProcessId: 200, routingId: 3, isDestroyed: () => false }
  const callbacks = new Map(), killed = [], sent = []
  let network
  const contents = Object.assign(new EventEmitter(), {
    id: 10, mainFrame: { url: 'http://127.0.0.1:1234/', processId: 1, framesInSubtree: [frame] },
    getOSProcessId: () => 100, isDestroyed: () => false,
    getLastWebPreferences: () => ({ sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }),
    session: { webRequest: { onBeforeRequest: (...args) => { network = args.at(-1) } } },
    send: (...args) => sent.push(args),
  })
  frame.parent = contents.mainFrame
  const window = { isDestroyed: () => false }
  const app = { commandLine: { hasSwitch: () => false, getSwitchValue: name => name === 'enable-features' ? 'IsolateSandboxedIframes:grouping/per-document' : '' }, getAppMetrics: () => [{ pid: 200, memory: { workingSetSize: 80000 } }] }
  const ipcMain = { handle: (name, callback) => callbacks.set(name, callback), removeHandler: name => callbacks.delete(name) }
  const controller = createNativeWidgetIsolationController({ app, ipcMain, getWindow: sender => sender === contents ? window : undefined, getGatewayOrigin: () => 'http://127.0.0.1:1234', verifiedPlatforms: ['win32'], platform: 'win32', runtimeVersions: { electron: '42.3.3', chrome: '148.0.7778.218' }, terminateProcess: pid => killed.push(pid), ...options })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const request = { widgetId: 'widget-a', revision: 1, frameName: frame.name, panelId: 'target-a:left' }
  const invoke = (method, value, override = event) => callbacks.get(`kcoder:widgets:${method}`)(override, value)
  return { controller, app, contents, frame, request, event, invoke, killed, sent, callbacks, getNetwork: () => network }
}

test('model-independent controller ownership: only the current Studio main frame can control widgets', () => {
  const f = fixture()
  try {
    assert.equal(f.invoke('capabilities').isolatedHtml, true)
    assert.throws(() => f.invoke('authorize', f.request, { ...f.event, senderFrame: f.frame }), /restricted/)
    f.contents.mainFrame.url = 'http://evil.example/'
    assert.throws(() => f.invoke('capabilities'), /no longer trusted/)
  } finally { f.controller.dispose() }
})

test('model-independent controller ownership: a lease protects parent/peer processes and blocks widget requests/navigation', () => {
  const f = fixture()
  try {
    const lease = f.invoke('authorize', f.request)
    assert.equal(lease.processSeparated, true)
    assert.equal(f.controller.activeCount(), 1)
    assert.throws(() => f.invoke('authorize', { ...f.request, widgetId: 'widget-b' }), /already owned/)
    let blocked
    f.getNetwork()({ frame: f.frame }, result => { blocked = result.cancel })
    assert.equal(blocked, true)
    f.getNetwork()({ frame: f.contents.mainFrame }, result => { blocked = result.cancel })
    assert.equal(blocked, false)
    let prevented = false
    f.contents.emit('will-frame-navigate', { frame: f.frame, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(f.invoke('revoke', { leaseId: 'other-owner' }).revoked, false)
    assert.equal(f.invoke('revoke', { leaseId: lease.leaseId }).revoked, true)
    assert.deepEqual(f.killed, [200])
    assert.equal(f.controller.activeCount(), 0)
  } finally { f.controller.dispose() }
})

test('model-independent controller ownership: changed native identity is never terminated using a stale PID', () => {
  const f = fixture()
  try {
    const lease = f.invoke('authorize', f.request)
    f.frame.osProcessId = 300
    f.invoke('revoke', { leaseId: lease.leaseId })
    assert.deepEqual(f.killed, [])
  } finally { f.controller.dispose() }
})

test('model-independent controller lifecycle: resource violation revokes only its lease and dispose unregisters every handler', () => {
  const f = fixture()
  const lease = f.invoke('authorize', f.request)
  assert.equal(f.invoke('heartbeat', { ...lease, domNodes: 4001, canvasPixels: 0, ready: true }).revoked, true)
  assert.deepEqual(f.killed, [200])
  assert.equal(f.sent.at(-1)[0], 'kcoder:widgets:revoked')
  assert.match(f.sent.at(-1)[1].reason, /DOM budget/)
  assert.throws(() => f.invoke('heartbeat', { ...lease, domNodes: 0, canvasPixels: 0, ready: true }), /no longer owned/)
  f.controller.dispose()
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.contents.listenerCount('will-frame-navigate'), 0)
})

test('production process configuration retains unrelated features and fixes per-document sandbox grouping', () => {
  let actual
  configureWidgetProcessIsolation({ commandLine: { getSwitchValue: () => 'OtherFeature,IsolateSandboxedIframes:grouping/per-origin', appendSwitch: (name, value) => { actual = [name, value] } } })
  assert.deepEqual(actual, ['enable-features', 'OtherFeature,IsolateSandboxedIframes:grouping/per-document'])
})

test('a renderer that closes outside the host still notifies its UI owner without killing a stale process', async () => {
  const f = fixture()
  try {
    f.invoke('authorize', f.request)
    f.frame.isDestroyed = () => true
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(f.controller.activeCount(), 0)
    assert.deepEqual(f.killed, [])
    assert.equal(f.sent.at(-1)[1].reason, 'component renderer closed')
  } finally { f.controller.dispose() }
})

test('main document reload revokes owned widgets immediately while in-page navigation preserves them', () => {
  const f = fixture()
  try {
    f.invoke('authorize', f.request)
    f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    assert.equal(f.controller.activeCount(), 1)
    f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    assert.equal(f.controller.activeCount(), 0)
    assert.deepEqual(f.killed, [200])
    assert.equal(f.sent.at(-1)[1].reason, 'Studio owner navigated')
  } finally { f.controller.dispose() }
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0)
  assert.equal(f.contents.listenerCount('render-process-gone'), 0)
})

test('native identity replacement rejects late heartbeats without killing a reused PID', () => {
  const f = fixture()
  try {
    const lease = f.invoke('authorize', f.request)
    f.frame.routingId = 99
    assert.equal(f.invoke('heartbeat', { ...lease, domNodes: 1, canvasPixels: 0, ready: true }).revoked, true)
    assert.equal(f.controller.activeCount(), 0)
    assert.deepEqual(f.killed, [])
    assert.equal(f.sent.at(-1)[1].reason, 'component renderer identity changed')
  } finally { f.controller.dispose() }
})

test('changing the iframe name cannot evade termination of the still-owned native renderer', () => {
  const f = fixture()
  try {
    const lease = f.invoke('authorize', f.request)
    f.frame.name = 'changed-by-untrusted-widget'
    assert.equal(f.invoke('heartbeat', { ...lease, domNodes: 1, canvasPixels: 0, ready: true }).revoked, true)
    assert.deepEqual(f.killed, [200])
  } finally { f.controller.dispose() }
})

test('native global/panel pools preserve peers when one component closes', () => {
  const f = fixture()
  const leases = []
  try {
    for (let index = 0; index < 7; index += 1) {
      const frame = index === 0 ? f.frame : { ...f.frame, name: `kcoder-widget-12345678-1234-1234-1234-123456789ab${index}`, osProcessId: 200 + index, processId: 2 + index, routingId: 3 + index }
      if (index) f.contents.mainFrame.framesInSubtree.push(frame)
      f.app.getAppMetrics = () => f.contents.mainFrame.framesInSubtree.map(frame => ({ pid: frame.osProcessId, memory: { workingSetSize: 80000 } }))
      const request = { ...f.request, widgetId: `widget-${index}`, frameName: frame.name, panelId: index < 3 ? 'left' : 'right' }
      if (index < 6) leases.push(f.invoke('authorize', request))
      else assert.throws(() => f.invoke('authorize', request), /frame pool is full/)
    }
    assert.equal(f.controller.activeCount(), 6)
    assert.throws(() => f.invoke('authorize', { ...f.request, widgetId: 'fourth-left' }), /frame pool is full/)
    f.invoke('revoke', { leaseId: leases[0].leaseId })
    assert.equal(f.controller.activeCount(), 5)
    assert.deepEqual(f.killed, [200])
    assert.equal(f.invoke('heartbeat', { ...leases[1], domNodes: 1, canvasPixels: 0, ready: true }).revoked, false)
  } finally { f.controller.dispose() }
})

test('missing or malformed live metrics revoke the owner rather than bypassing RSS checks or throwing from the timer', async () => {
  for (const metrics of [[], [{ pid: 200, memory: null }]]) {
    const f = fixture()
    try {
      f.invoke('authorize', f.request)
      f.app.getAppMetrics = () => metrics
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(f.controller.activeCount(), 0)
      assert.deepEqual(f.killed, [200])
      assert.equal(f.sent.at(-1)[1].reason, 'native renderer metrics became unavailable')
    } finally { f.controller.dispose() }
  }
})

test('first-frame verification has a shorter external startup deadline than normal interaction', async () => {
  let clock = 0
  const f = fixture({ now: () => clock })
  try {
    f.invoke('authorize', { ...f.request, verificationOnly: true })
    clock = 2600
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(f.controller.activeCount(), 0)
    assert.equal(f.sent.at(-1)[1].reason, 'component did not become ready')
  } finally { f.controller.dispose() }
})

test('a process that becomes shared with a peer is never terminated by stale lease cleanup', () => {
  const f = fixture()
  try {
    const lease = f.invoke('authorize', f.request)
    const peer = { ...f.frame, name: 'peer', routingId: 100 }
    f.contents.mainFrame.framesInSubtree.push(peer)
    f.invoke('revoke', { leaseId: lease.leaseId })
    assert.deepEqual(f.killed, [])
    assert.equal(f.controller.activeCount(), 0)
  } finally { f.controller.dispose() }
})
