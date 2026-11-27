import { expect, test, vi } from 'vitest'
import { createMcpAppApi } from './mcpAppApi'
import { widgetContentSha256 } from '@/features/widgets/contentHash'
import type { WidgetRequest } from './widgetApi'
import type { McpAppReadResult, WidgetRef } from '../../../shared/generated/contracts'

const widget: WidgetRef = {
  widgetId: 'app',
  threadId: 'thread',
  turnId: 'turn',
  attemptId: 'attempt',
  toolCallId: 'call',
  revision: 2,
  title: 'App',
  summary: 'Summary',
  format: 'html',
  executionMode: 'isolated_html',
  libraries: [],
  bytes: 4,
  sha256: 'a'.repeat(64),
  createdAtMs: 1,
  mcpApp: {
    serverName: 'original',
    connectionId: 'connection',
    toolName: 'table',
    resourceUri: 'ui://table',
    mimeType: 'text/html;profile=mcp-app',
    pluginId: null,
  },
}
const address = { deviceId: 'ssh-target', taskId: 'task', threadId: 'thread' }
async function fixture(corrupt?: 'hash' | 'offset' | 'identity') {
  const original = {
    contents: [
      {
        uri: 'app://data',
        mimeType: 'text/plain',
        text: '多字节数据'.repeat(6000),
        _meta: { uiOnly: true },
      },
    ],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(original))
  const sha256 = await widgetContentSha256(bytes)
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'mcp/apps/resourceRead')
      return {
        resource: {
          resourceId: 'resource-1',
          sha256,
          bytes: bytes.length,
          uri: 'app://data',
          contentCount: 1,
          encoding: 'json',
          mimeType: null,
        },
      }
    const offset = Number(params.offset),
      nextOffset = Math.min(offset + 32768, bytes.length)
    const chunk = bytes.slice(offset, nextOffset)
    if (corrupt === 'hash') chunk[0] ^= 1
    return {
      resourceId: corrupt === 'identity' ? 'peer-resource' : 'resource-1',
      sha256,
      bytes: bytes.length,
      offset,
      nextOffset: corrupt === 'offset' ? offset : nextOffset,
      dataBase64: btoa(String.fromCharCode(...chunk)),
    }
  })
  return { original, request, api: createMcpAppApi(address, 'thread', request as WidgetRequest) }
}
test('App resources stay on the bound RPC connection and verify every chunk before exposing original JSON', async () => {
  const { original, request, api } = await fixture()
  expect(await api.resourceRead(widget, 'app://data')).toEqual(original)
  expect(request.mock.calls.length).toBeGreaterThan(2)
  for (const [, params] of request.mock.calls)
    expect(params).toMatchObject({
      threadId: 'thread',
      widgetId: 'app',
      revision: 2,
      connectionId: 'connection',
    })
  expect(request.mock.calls.every(([method]) => method.startsWith('mcp/apps/'))).toBe(true)
})
test.each(['hash', 'offset', 'identity'] as const)(
  'App resource %s corruption never reaches the frame',
  async corrupt => {
    const { api } = await fixture(corrupt)
    await expect(api.resourceRead(widget, 'app://data')).rejects.toThrow()
  }
)
test('read rejects a changed original connection even when artifact ID and revision match', async () => {
  const result: McpAppReadResult = {
    widget: { ...widget, mcpApp: { ...widget.mcpApp!, connectionId: 'replacement' } },
    protocolVersion: '2026-01-26',
    live: true,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    requestedPermissions: {
      camera: false,
      microphone: false,
      geolocation: false,
      clipboardWrite: false,
    },
    toolContent: [],
    allowedTools: [],
    resourcesEnabled: false,
  }
  const request = vi.fn(async () => result) as WidgetRequest
  await expect(createMcpAppApi(address, 'thread', request).read(widget)).rejects.toThrow(
    'identity changed'
  )
})
test('operation receipts must name the exact stable operation ID', async () => {
  const request = vi.fn(async () => ({
    operationId: 'other',
    status: 'completed',
    result: { content: [] },
  })) as WidgetRequest
  await expect(
    createMcpAppApi(address, 'thread', request).operationRead(widget, 'owned')
  ).rejects.toThrow('receipt')
})
