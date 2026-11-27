import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectNativeWidgetIsolation, verifyNativeWidgetFrame, widgetResourceViolation, NATIVE_WIDGET_LIMITS } from './policy.mjs'

const preferences = { sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false }
const parent = { mainFrame: { processId: 1 }, getOSProcessId: () => 100, getLastWebPreferences: () => preferences }
const app = { commandLine: { hasSwitch: () => false, getSwitchValue: name => name === 'enable-features' ? 'IsolateSandboxedIframes:grouping/per-document' : '' } }
const base = { app, contents: parent, platform: 'win32', verifiedPlatforms: ['win32'], electronVersion: '42.3.3', chromiumVersion: '148.0.7778.218' }
test('native JS capability requires actual verified platform/version and enabled process sandbox', () => {
  assert.deepEqual(inspectNativeWidgetIsolation(base), { enabled: true })
  assert.equal(inspectNativeWidgetIsolation({ ...base, verifiedPlatforms: [] }).enabled, false)
  assert.equal(inspectNativeWidgetIsolation({ ...base, electronVersion: '43.0.0' }).enabled, false)
  assert.equal(inspectNativeWidgetIsolation({ ...base, app: { commandLine: { hasSwitch: name => name === 'no-sandbox' } } }).enabled, false)
  assert.equal(inspectNativeWidgetIsolation({ ...base, contents: { getLastWebPreferences: () => ({ ...preferences, nodeIntegration: true }) } }).enabled, false)
})

test('frame admission checks actual process separation and refuses peer process reuse', () => {
  const frame = { isDestroyed: () => false, name: 'kcoder-widget-token', origin: 'null', url: 'http://127.0.0.1:1234/api/widgets/isolated-v1.html', processId: 2, osProcessId: 200, routingId: 3 }
  const input = { frame, parent, origin: 'http://127.0.0.1:1234', frameName: frame.name }
  assert.deepEqual(verifyNativeWidgetFrame(input), { processId: 2, osProcessId: 200, routingId: 3 })
  for (const changes of [{ origin: 'http://127.0.0.1:1234' }, { processId: 1 }, { osProcessId: 100 }, { url: 'http://evil.example/api/widgets/isolated-v1.html' }, { name: 'another-owner' }, { isDestroyed: () => true }]) assert.throws(() => verifyNativeWidgetFrame({ ...input, frame: { ...frame, ...changes } }), /resource_blocked/)
  assert.throws(() => verifyNativeWidgetFrame({ ...input, usedProcessIds: new Set([200]) }), /already owned/)
})

test('resource census is a bounded external watchdog, not a child-frame hard timeout', () => {
  const entry = { createdAt: 100, lastHeartbeat: 200, ready: true, domNodes: 20, canvasPixels: 700 * 320 }
  const metric = { memory: { workingSetSize: 100 * 1024 } }
  assert.equal(widgetResourceViolation(entry, 300, metric), null)
  assert.match(widgetResourceViolation(entry, 3000, metric), /stopped responding/)
  assert.match(widgetResourceViolation(entry, 300, { memory: { workingSetSize: NATIVE_WIDGET_LIMITS.residentKiB + 1 } }), /memory/)
  assert.match(widgetResourceViolation({ ...entry, domNodes: 4001 }, 300, metric), /DOM/)
  assert.match(widgetResourceViolation({ ...entry, canvasPixels: NATIVE_WIDGET_LIMITS.canvasPixels + 1 }, 300, metric), /canvas/)
  assert.match(widgetResourceViolation({ ...entry, ready: false, startupBudgetMs: 2500 }, 2700, metric), /did not become ready/)
})
