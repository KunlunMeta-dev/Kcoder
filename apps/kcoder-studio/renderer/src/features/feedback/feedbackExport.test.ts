import { Blob as NodeBlob, Buffer } from 'node:buffer'
import JSZip from 'jszip'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createGatewayIpcHandler } from '@/kcoder/gatewayRuntimeInstall'
import { createGatewayPageIpcHandler } from '@/kcoder/gateway/install/ipc'
import { captureFeedbackScreenshot, exportFeedbackBundle, feedbackCapabilities, type FeedbackExportRequest } from './feedbackExport'

const state = vi.hoisted(() => ({ host: undefined as unknown }))
vi.mock('@/kcoder/desktopHost', () => ({ desktopHost: () => state.host }))
let archive: NodeBlob
beforeEach(() => {
  state.host = undefined
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('Blob', NodeBlob)
  // jsdom has no TextEncoder; its Node fallback returns a different realm's array.
  const encoder = new TextEncoder()
  vi.stubGlobal('TextEncoder', class {
    encode(value: string) { return Uint8Array.from(encoder.encode(value)) }
  })
  vi.stubGlobal('URL', { createObjectURL: (blob: NodeBlob) => { archive = blob; return 'blob:http://localhost/feedback' }, revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const request = (patch: Partial<FeedbackExportRequest> = {}): FeedbackExportRequest => ({
  destination: null, includeRuntimeLogs: false, includeTaskInfo: true, includeScreenshot: false,
  includeSystemInfo: true, note: 'https://owned.example/#token=note-secret',
  taskContext: { taskId: 'owned-task', api_key: 'private-key', nested: { KCODER_STUDIO_AUTH_TOKEN: 'private-token' },
    content: 'Authorization: Bearer private-bearer\nhttps://user:password@owned.example/?code=private-code' },
  screenshotDataUrl: null, ...patch,
})
const readArchive = async () => JSZip.loadAsync(Buffer.from(await archive.arrayBuffer()))

test.each([createGatewayIpcHandler, createGatewayPageIpcHandler])('real Gateway command adapter exports a readable browser ZIP', async factory => {
  const result = await factory({} as never)('export_feedback_bundle', { request: request() })
  expect(result).toMatchObject({ downloadStatus: 'requested', warnings: [] })
  const zip = await readArchive()
  const task = await zip.file('context/task.json')!.async('string')
  for (const secret of ['private-key', 'private-token', 'private-bearer', 'user:password', 'private-code']) expect(task).not.toContain(secret)
  expect(task).toContain('owned-task')
  expect(await zip.file('report.md')!.async('string')).not.toContain('note-secret')
  expect(JSON.parse(await zip.file('manifest.json')!.async('string')).included).toEqual(['taskInfo', 'systemInfo'])
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  expect(feedbackCapabilities()).toEqual({ runtimeLogs: false, screenshot: false })
  expect(() => captureFeedbackScreenshot()).toThrow(/unavailable/)
})

test('desktop ZIP preserves selected host data and reports its download completion receipt', async () => {
  const capture = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
  const diagnostics = vi.fn(async () => ({ runtimeLogs: '界'.repeat(1024 * 1024) + '\nAuthorization: Bearer log-secret\nCookie: session=private-cookie\n',
    systemInfo: { architecture: 'arm64', version: '2.0.26' } }))
  const download = vi.fn(async () => ({ status: 'completed' }))
  state.host = { captureFeedbackScreenshot: capture, readFeedbackDiagnostics: diagnostics, download }
  const image = await captureFeedbackScreenshot()
  const result = await exportFeedbackBundle(request({ includeScreenshot: true, includeRuntimeLogs: true, screenshotDataUrl: image }))
  expect(result?.downloadStatus).toBe('completed')
  expect(diagnostics).toHaveBeenCalledWith({ runtimeLogs: true, systemInfo: true })
  const zip = await readArchive()
  expect(await zip.file('screenshot.png')!.async('uint8array')).toEqual(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10))
  const logs = await zip.file('logs/runtime.log')!.async('uint8array')
  expect(logs.length).toBeLessThanOrEqual(1024 * 1024)
  expect(new TextDecoder().decode(logs)).not.toMatch(/log-secret|private-cookie/)
  expect(JSON.parse(await zip.file('environment.json')!.async('string')).architecture).toBe('arm64')
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
})

test('unavailable options are explicit and unselected task content is never serialized', async () => {
  const result = await exportFeedbackBundle(request({ includeTaskInfo: false, includeRuntimeLogs: true, includeScreenshot: true }))
  expect(result?.warnings).toEqual(['RUNTIME_LOGS_UNAVAILABLE', 'SCREENSHOT_UNAVAILABLE'])
  const zip = await readArchive()
  expect(zip.file('context/task.json')).toBeNull()
  expect(zip.file('screenshot.png')).toBeNull()
})

test('cancelled and interrupted desktop downloads never report export success', async () => {
  state.host = { download: async () => ({ status: 'cancelled' }) }
  expect(await exportFeedbackBundle(request())).toBeNull()
  state.host = { download: async () => ({ status: 'interrupted' }) }
  await expect(exportFeedbackBundle(request())).rejects.toThrow(/interrupted/)
})

test('context and note limits reject oversized diagnostic requests', async () => {
  await expect(exportFeedbackBundle(request({ note: 'x'.repeat(16385) }))).rejects.toThrow(/Invalid/)
  await expect(exportFeedbackBundle(request({ taskContext: 'x'.repeat(1024 * 1024 + 1) }))).rejects.toThrow(/exceeds/)
})

test('HTTP clients can export when randomUUID is unavailable', async () => {
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(17) })
  const result = await exportFeedbackBundle(request())
  expect(result?.reportId).toBe('KC-11111111-1111-4111-9111-111111111111')
})
