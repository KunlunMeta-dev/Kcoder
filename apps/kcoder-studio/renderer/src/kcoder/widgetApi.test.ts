import { expect, test, vi } from 'vitest'
import { createWidgetApi, validateWidgetReference, type WidgetRequest } from './widgetApi'
import { widgetContentSha256 } from '@/features/widgets/contentHash'
import type { WidgetRef } from '../../../shared/generated/contracts'

const address = { deviceId: 'ssh-target', taskId: 'task', threadId: 'thread' }
async function fixture(source = `<svg>${'多字节内容'.repeat(4000)}</svg>`) {
  const bytes = new TextEncoder().encode(source)
  const widget: WidgetRef = {
    widgetId: 'w-1',
    threadId: 'thread',
    turnId: 'turn',
    attemptId: 'attempt',
    toolCallId: 'call',
    revision: 1,
    title: 'Diagram',
    summary: 'Summary',
    format: 'svg',
    executionMode: 'managed',
    libraries: [],
    bytes: bytes.length,
    sha256: await widgetContentSha256(bytes),
    createdAtMs: 1,
  }
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'widget/list') return { widgets: [widget], nextOffset: null }
    if (method === 'widget/read') return { widget }
    const offset = Number(params.offset)
    const end = Math.min(bytes.length, offset + 32768)
    return {
      widgetId: widget.widgetId,
      revision: 1,
      sha256: widget.sha256,
      bytes: bytes.length,
      offset,
      nextOffset: end,
      dataBase64: btoa(String.fromCharCode(...bytes.slice(offset, end))),
    }
  })
  return {
    source,
    bytes,
    widget,
    request,
    api: createWidgetApi(address, 'thread', request as WidgetRequest),
  }
}

test('widget content assembles verified bounded byte chunks across UTF-8 boundaries and reuses the verified body', async () => {
  const { api, widget, source, request } = await fixture()
  expect(await api.content(widget, new AbortController().signal)).toBe(source)
  expect(request.mock.calls.every(([, params]) => Number(params.offset) % 32768 === 0)).toBe(true)
  expect(request.mock.calls.length).toBeGreaterThan(1)
  const calls = request.mock.calls.length
  expect(await api.content(widget, new AbortController().signal)).toBe(source)
  expect(request.mock.calls).toHaveLength(calls)
})

test.each(['hash', 'identity', 'offset', 'size'])(
  'widget chunk %s corruption is rejected',
  async kind => {
    const { widget, request } = await fixture('<svg><rect /></svg>')
    const corrupt: WidgetRequest = async <T>(method: string, params: Record<string, unknown>) => {
      const chunk = (await request(method, params)) as Record<string, unknown>
      return {
        ...chunk,
        ...(kind === 'hash'
          ? { dataBase64: btoa('<svg><path /></svg>') }
          : kind === 'identity'
            ? { revision: 2 }
            : kind === 'offset'
              ? { nextOffset: 0 }
              : { bytes: widget.bytes + 1 }),
      } as T
    }
    const api = createWidgetApi(address, 'thread', corrupt)
    await expect(api.content(widget, new AbortController().signal)).rejects.toThrow(
      'artifact_unavailable'
    )
  }
)

test('widget listings reject foreign thread references and non-progressing pagination', async () => {
  const { widget } = await fixture('<svg />')
  expect(() => validateWidgetReference({ ...widget, threadId: 'foreign' }, 'thread')).toThrow()
  const request = vi.fn().mockResolvedValue({ widgets: [widget], nextOffset: 0 }) as WidgetRequest
  await expect(createWidgetApi(address, 'thread', request).list()).rejects.toThrow('cursor')
})

test('cancelled widget content reads never submit a chunk request', async () => {
  const { api, widget, request } = await fixture('<svg />')
  const controller = new AbortController()
  controller.abort()
  await expect(api.content(widget, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(request).not.toHaveBeenCalled()
})
