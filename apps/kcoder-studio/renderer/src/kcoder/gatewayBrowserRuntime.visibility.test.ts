import { afterEach, expect, test, vi } from 'vitest'
import { GatewayBrowserRuntime } from './gatewayBrowserRuntime'
import type { GatewayClient } from './gatewayRuntimeTypes'
import type { GatewayServer } from './gatewayRpc'

const runtimes: GatewayBrowserRuntime[] = []

function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value)
  document.dispatchEvent(new Event('visibilitychange'))
}

function setup() {
  vi.useFakeTimers()
  visibility('visible')
  const client = Object.assign(new EventTarget(), {
    request: vi.fn<GatewayClient['request']>(async <T>(method: string) => {
      if (method === 'browser/start')
        return { session_id: 'owned', url: 'https://example.test/' } as T
      if (method === 'browser/screenshot') return frame as T
      return {} as T
    }),
    close: vi.fn(),
    supportsExperimental: () => true,
  })
  const runtime = new GatewayBrowserRuntime({
    resolveServerForLabel: async () => ({ id: 'local' }) as GatewayServer,
    connectBrowserClient: async () => client,
  })
  runtimes.push(runtime)
  const countFrames = () =>
    client.request.mock.calls.filter(([method]) => method === 'browser/screenshot').length
  return { runtime, client, countFrames }
}

const frame = { session_id: 'owned', data_base64: 'AA==', mime_type: 'image/png' }
const open = { label: 'owned', url: 'https://example.test/', bounds: { width: 640, height: 480 } }

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('pauses screenshot reads while hidden and resumes only visible surfaces without closing the session', async () => {
  const { runtime, client, countFrames } = setup()
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(500)
  expect(countFrames()).toBe(3)
  visibility('hidden')
  await vi.advanceTimersByTimeAsync(2000)
  expect(countFrames()).toBe(3)
  expect(client.close).not.toHaveBeenCalled()
  expect(client.request.mock.calls.some(([method]) => method === 'browser/close')).toBe(false)
  visibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(4)
  await runtime.setBrowserBounds({ ...open, visible: false })
  visibility('hidden')
  visibility('visible')
  await vi.advanceTimersByTimeAsync(500)
  expect(countFrames()).toBe(4)
})

test('opening or executing browser work in a hidden tab does not pull display frames', async () => {
  const { runtime, client, countFrames } = setup()
  visibility('hidden')
  await runtime.openBrowser(open)
  await runtime.evaluateBrowser({ label: 'owned', expression: '1 + 1' })
  await runtime.controlBrowser('owned', { action: 'reload' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(client.request.mock.calls.map(([method]) => method)).toContain('browser/action')
  expect(client.request.mock.calls.map(([method]) => method)).toContain('browser/evaluate')
  expect(countFrames()).toBe(0)
  visibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(1)
})

test('a screenshot finishing while hidden cannot restart polling; rapid foreground events do not overlap it', async () => {
  const { runtime, client, countFrames } = setup()
  let finish!: (value: typeof frame) => void
  const pending = new Promise<typeof frame>(resolve => {
    finish = resolve
  })
  const original = client.request.getMockImplementation()!
  client.request.mockImplementation(<T>(method: string, params?: unknown) =>
    method === 'browser/screenshot' ? (pending as Promise<T>) : original<T>(method, params)
  )
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  visibility('hidden')
  visibility('visible')
  visibility('visible')
  expect(countFrames()).toBe(1)
  visibility('hidden')
  finish(frame)
  await vi.advanceTimersByTimeAsync(2000)
  expect(countFrames()).toBe(1)
  visibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(2)
})

test.each(['disconnect', 'close', 'dispose'] as const)(
  'foreground does not revive a browser after %s',
  async terminal => {
    const { runtime, client, countFrames } = setup()
    await runtime.openBrowser(open)
    await vi.advanceTimersByTimeAsync(0)
    visibility('hidden')
    if (terminal === 'disconnect') client.dispatchEvent(new Event('close'))
    else if (terminal === 'close') await runtime.closeBrowser('owned')
    else await runtime.dispose()
    visibility('visible')
    await vi.advanceTimersByTimeAsync(1000)
    expect(countFrames()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  }
)

test('bounds acknowledgements and position-only changes preserve normal frame cadence', async () => {
  const { runtime, client, countFrames } = setup()
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(1)
  for (let index = 0; index < 20; index++) {
    await runtime.setBrowserBounds({ ...open, bounds: { ...open.bounds, x: index, y: index * 2 }, visible: true })
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(countFrames()).toBe(1)
  const surface = document.querySelector<HTMLElement>('[data-browser-label="owned"]')!
  expect(surface.style.left).toBe('19px')
  expect(surface.style.top).toBe('38px')
  await vi.advanceTimersByTimeAsync(230)
  expect(countFrames()).toBe(2)
  await runtime.setBrowserBounds({ ...open, visible: false })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(countFrames()).toBe(2)
  await runtime.setBrowserBounds({ ...open, visible: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(3)
  await runtime.setBrowserBounds({ ...open, bounds: { width: 800, height: 600 }, visible: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(4)
  expect(client.request.mock.calls.filter(([method, params]) =>
    method === 'browser/action' && params?.action === 'resize')).toHaveLength(1)
  await runtime.controlBrowser('owned', { action: 'reload' })
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(5)
  await runtime.evaluateBrowser({ label: 'owned', expression: '1 + 1' })
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(6)
})

test('unchanged layout during a slow screenshot does not queue another immediate capture', async () => {
  const { runtime, client, countFrames } = setup()
  let finish!: (value: typeof frame) => void
  const pending = new Promise<typeof frame>(resolve => { finish = resolve })
  const original = client.request.getMockImplementation()!
  client.request.mockImplementation(<T>(method: string, params?: unknown) =>
    method === 'browser/screenshot' ? (pending as Promise<T>) : original<T>(method, params))
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 20; index++) await runtime.setBrowserBounds({ ...open, visible: true })
  finish(frame)
  await vi.advanceTimersByTimeAsync(1)
  expect(countFrames()).toBe(1)
  await vi.advanceTimersByTimeAsync(249)
  expect(countFrames()).toBe(2)
})

test('hidden placeholder bounds preserve the browser viewport and returning only refreshes its frame', async () => {
  const { runtime, client, countFrames } = setup()
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  await runtime.setBrowserBounds({ ...open, bounds: { width: 1, height: 1 }, visible: false })
  await runtime.setBrowserBounds({ ...open, bounds: { width: 100, height: 100 }, visible: false })
  await vi.advanceTimersByTimeAsync(1000)
  expect(countFrames()).toBe(1)
  await runtime.setBrowserBounds({ ...open, visible: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(countFrames()).toBe(2)
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(0)
  const larger = { ...open, bounds: { width: 800, height: 600 } }
  await runtime.setBrowserBounds({ ...larger, visible: false })
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(0)
  await runtime.setBrowserBounds({ ...larger, visible: true })
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(1)
})

test('layout changes outside the Native viewport range do not repeat the same resize', async () => {
  const { runtime, client } = setup()
  await runtime.openBrowser({ ...open, bounds: { width: 2200, height: 1400 } })
  await vi.advanceTimersByTimeAsync(0)
  for (const bounds of [{ width: 2400, height: 1500 }, { width: 2100, height: 1200 }]) {
    await runtime.setBrowserBounds({ ...open, bounds, visible: true })
  }
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(0)
  const surface = document.querySelector<HTMLElement>('[data-browser-label="owned"]')!
  expect(surface.style.width).toBe('2100px')
  expect(surface.style.height).toBe('1200px')
  await runtime.setBrowserBounds({ ...open, bounds: { width: 100, height: 100 }, visible: true })
  await runtime.setBrowserBounds({ ...open, bounds: { width: 200, height: 200 }, visible: true })
  expect(client.request.mock.calls.filter(([method, params]) =>
    method === 'browser/action' && params?.action === 'resize')).toEqual([
    ['browser/action', { session_id: 'owned', action: 'resize', width: 320, height: 240 }],
  ])
})

test('failed resize can be retried by the next layout synchronization', async () => {
  const { runtime, client } = setup()
  await runtime.openBrowser(open)
  const original = client.request.getMockImplementation()!
  let fail = true
  client.request.mockImplementation(async <T>(method: string, params?: unknown) => {
    if (method === 'browser/action' && fail) {
      fail = false
      throw new Error('resize rejected')
    }
    return original<T>(method, params)
  })
  const next = { ...open, bounds: { width: 800, height: 600 }, visible: true }
  await expect(runtime.setBrowserBounds(next)).rejects.toThrow('resize rejected')
  await runtime.setBrowserBounds(next)
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(2)
})

test('layout acknowledgements during a pending resize share its effective viewport', async () => {
  const { runtime, client, countFrames } = setup()
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const original = client.request.getMockImplementation()!
  client.request.mockImplementation(async <T>(method: string, params?: unknown) => {
    if (method === 'browser/action') await pending
    return original<T>(method, params)
  })
  const updates = Array.from({ length: 20 }, (_, x) => runtime.setBrowserBounds({
    ...open, bounds: { x, width: 800, height: 600 }, visible: true,
  }))
  finish()
  await Promise.all(updates)
  await vi.advanceTimersByTimeAsync(0)
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(1)
  expect(countFrames()).toBe(2)
})

test('animated display bounds defer Native resizing until the settled layout update', async () => {
  const { runtime, client } = setup()
  await runtime.openBrowser(open)
  await vi.advanceTimersByTimeAsync(0)
  for (const width of [320, 400, 500, 600, 640]) {
    await runtime.setBrowserBounds({
      ...open, bounds: { width, height: 480 }, visible: true, resizeViewport: false,
    })
    expect(document.querySelector<HTMLElement>('[data-browser-label="owned"]')!.style.width).toBe(`${width}px`)
  }
  await runtime.setBrowserBounds({ ...open, visible: true })
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(0)
  const larger = { ...open, bounds: { width: 800, height: 600 }, visible: true }
  await runtime.setBrowserBounds({ ...larger, resizeViewport: false })
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(0)
  await runtime.setBrowserBounds(larger)
  expect(client.request.mock.calls.filter(([method]) => method === 'browser/action')).toHaveLength(1)
})
