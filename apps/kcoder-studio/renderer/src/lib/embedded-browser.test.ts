import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@/lib/runtime-commands'
import {
  evalEmbeddedBrowserJson,
  listenEmbeddedBrowserOpenRequests,
  relabelEmbeddedBrowser,
  requestEmbeddedBrowserOpen,
} from './embedded-browser'

const unlistenMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/runtime-commands', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/runtime-events', () => ({
  listen: vi.fn().mockResolvedValue(unlistenMock),
}))

vi.mock('./runtime-environment', () => ({
  isGatewayRuntime: vi.fn(() => true),
}))

const invokeMock = vi.mocked(invoke)

describe('embedded-browser', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('unwraps successful eval result values', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      value: [{ comment: 'Check this area' }],
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Check this area' },
    ])
  })

  test('keeps direct eval values for compatibility', async () => {
    invokeMock.mockResolvedValue([{ comment: 'Direct value' }])

    await expect(evalEmbeddedBrowserJson('window.consume()')).resolves.toEqual([
      { comment: 'Direct value' },
    ])
  })

  test('throws failed eval result errors', async () => {
    invokeMock.mockResolvedValue({
      ok: false,
      error: 'Evaluation failed',
    })

    await expect(evalEmbeddedBrowserJson('window.consume()')).rejects.toThrow('Evaluation failed')
  })

  test('relabels an embedded browser through Gateway', async () => {
    invokeMock.mockResolvedValue(undefined)

    await relabelEmbeddedBrowser('workspace-browser-blank-0', 'workspace-browser-task-1')

    expect(invokeMock).toHaveBeenCalledWith('embedded_browser_relabel', {
      fromLabel: 'workspace-browser-blank-0',
      toLabel: 'workspace-browser-task-1',
    })
  })

  test('routes frontend open requests to the active embedded browser listener', async () => {
    const handler = vi.fn()
    const unlisten = listenEmbeddedBrowserOpenRequests(handler)

    expect(requestEmbeddedBrowserOpen('http://localhost:3000')).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      label: 'workspace-browser',
      url: 'http://localhost:3000/',
    })
    expect(requestEmbeddedBrowserOpen('https://example.test/trend.html')).toBe(true)
    expect(handler).toHaveBeenCalledWith({
      label: 'workspace-browser',
      url: 'https://example.test/trend.html',
    })
    expect(requestEmbeddedBrowserOpen('ftp://localhost/resource')).toBe(false)
    expect(handler).toHaveBeenCalledTimes(2)

    const release = await unlisten
    release?.()
  })
})
