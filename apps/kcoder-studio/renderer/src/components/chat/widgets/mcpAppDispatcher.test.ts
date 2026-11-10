import { beforeEach, expect, test, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createMcpAppDispatcher } from './mcpAppDispatcher'
import type { McpAppApi, McpAppHostView } from '@/kcoder/mcpAppApi'
import type { WidgetJson, WidgetTheme } from '@/features/widgets'
import type { WidgetRef } from '../../../../../shared/generated/contracts'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
const widget: WidgetRef = {
  widgetId: 'app',
  threadId: 'thread',
  turnId: 'turn',
  attemptId: 'attempt',
  toolCallId: 'call',
  revision: 1,
  title: 'App',
  summary: 'Retained App',
  format: 'html',
  executionMode: 'isolated_html',
  libraries: [],
  bytes: 4,
  sha256: 'a'.repeat(64),
  createdAtMs: 1,
  mcpApp: {
    connectionId: 'original',
    serverName: 'server',
    toolName: 'overview',
    mimeType: 'text/html;profile=mcp-app',
    resourceUri: 'ui://overview',
    pluginId: null,
  },
}
const theme: WidgetTheme = {
  colorScheme: 'light',
  locale: 'zh-CN',
  background: '#fff',
  foreground: '#111',
  muted: '#666',
  primary: '#07f',
  border: '#ddd',
  success: '#080',
  destructive: '#f00',
  fontFamily: 'system-ui',
  fontSize: 'inherit',
  reducedMotion: true,
}
function fixture(live = true) {
  const view: McpAppHostView = {
    widget,
    live,
    protocolVersion: '2026-01-26',
    csp: {
      connectDomains: ['https://unapproved.invalid'],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    requestedPermissions: {
      camera: true,
      microphone: false,
      geolocation: false,
      clipboardWrite: false,
    },
    toolInput: { value: 7 },
    toolContent: [{ type: 'text', text: 'visible text' }],
    structuredContent: { privateUi: 8 },
    resultMeta: { secretUi: 'ui-only' },
    allowedTools: live ? ['refresh'] : [],
    resourcesEnabled: live,
    toolInfo: live
      ? {
          name: 'overview',
          inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
        }
      : undefined,
  }
  const api = {
    read: vi.fn(async () => view),
    toolCall: vi.fn(async (_widget, operationId) => ({
      operationId,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] },
    })),
    operationRead: vi.fn(),
    resourceRead: vi.fn(async () => ({ contents: [{ uri: 'app://data', text: 'retained data' }] })),
  } as unknown as McpAppApi
  const draft = vi.fn(async () => {})
  const reply = vi.fn()
  const dispatcher = createMcpAppDispatcher({
    widget,
    api,
    isCurrent: () => true,
    theme: () => theme,
    requestDraft: draft,
  })
  const receive = (message: Record<string, WidgetJson>) =>
    dispatcher.receive({ widget, message, reply, resize: vi.fn() })
  const initialize = async () => {
    await receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'app', version: '1' },
        appCapabilities: {},
      },
    })
    await receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
  }
  return { dispatcher, api, draft, reply, receive, initialize }
}
test('official handshake advertises only implemented live capabilities and sends original data in order', async () => {
  const { initialize, reply, dispatcher } = fixture()
  await initialize()
  const result = reply.mock.calls[0][0].result
  expect(result.hostContext).not.toHaveProperty('containerDimensions.maxHeight')
  expect(result.hostCapabilities).toEqual({
    serverResources: {},
    serverTools: {},
    sandbox: {
      permissions: {},
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    },
  })
  expect(result.hostContext.toolInfo.tool.inputSchema.properties.value.type).toBe('number')
  expect(reply.mock.calls.slice(1).map(call => call[0].method)).toEqual([
    'ui/notifications/tool-input',
    'ui/notifications/tool-result',
  ])
  expect(reply.mock.calls[1][0].params.arguments).toEqual({ value: 7 })
  expect(reply.mock.calls[2][0].params).toEqual({
    content: [{ type: 'text', text: 'visible text' }],
    structuredContent: { privateUi: 8 },
    _meta: { secretUi: 'ui-only' },
  })
  dispatcher.dispose()
  expect(reply.mock.calls.at(-1)?.[0].method).toBe('ui/resource-teardown')
})
test('retained history stays readable without reconnecting or promising tool/resource access', async () => {
  const { initialize, receive, reply, api } = fixture(false)
  await initialize()
  expect(reply.mock.calls[0][0].result.hostCapabilities).not.toHaveProperty('serverTools')
  expect(reply.mock.calls[0][0].result.hostCapabilities).not.toHaveProperty('serverResources')
  await receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: {} },
  })
  await receive({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'app://data' } })
  expect(api.toolCall).not.toHaveBeenCalled()
  expect(api.resourceRead).not.toHaveBeenCalled()
  expect(reply.mock.calls.at(-1)?.[0].error.message).toContain('read-only')
})
test('lost tool responses reconcile one mounted frame without repeating the call', async () => {
  const first = fixture()
  vi.mocked(first.api.toolCall).mockRejectedValue(new Error('response lost'))
  vi.mocked(first.api.operationRead).mockImplementation(async (_widget, operationId) => ({
    operationId,
    status: 'outcome_unknown',
  }))
  await first.initialize()
  const request = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: { value: 3 } },
  } as Record<string, WidgetJson>
  await first.receive(request)
  await first.receive(request)
  expect(first.api.toolCall).toHaveBeenCalledTimes(1)
  expect(first.api.operationRead).toHaveBeenCalledTimes(1)
  const operationId = vi.mocked(first.api.toolCall).mock.calls[0][1]
  expect(first.api.operationRead).toHaveBeenCalledWith(widget, operationId, expect.any(AbortSignal))
  expect(first.reply.mock.calls.at(-1)?.[0].error.data).toEqual({
    operationId,
    status: 'outcome_unknown',
    errorCode: null,
  })
})
test('identity reuse, foreign tools and unsupported external actions do not reach execution', async () => {
  const { initialize, receive, reply, api } = fixture()
  await initialize()
  await receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'other-server-tool', arguments: {} },
  })
  expect(api.toolCall).not.toHaveBeenCalled()
  await receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: {} },
  })
  expect(reply.mock.calls.at(-1)?.[0].error.message).toContain('identity')
  await receive({
    jsonrpc: '2.0',
    id: 3,
    method: 'ui/open-link',
    params: { url: 'https://example.com' },
  })
  expect(reply.mock.calls.at(-1)?.[0].error.code).toBe(-32601)
  await receive({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'app://data' } })
  expect(api.resourceRead).toHaveBeenCalledWith(widget, 'app://data', expect.any(AbortSignal))
})
test('App messages wait for the user draft decision; teardown cancels subsequent requests', async () => {
  const { initialize, receive, reply, draft, dispatcher } = fixture()
  await initialize()
  let accept!: () => void
  draft.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        accept = resolve
      })
  )
  const pending = receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'ui/message',
    params: { role: 'user', content: { type: 'text', text: 'Explain this' } },
  })
  await vi.waitFor(() => expect(draft).toHaveBeenCalledExactlyOnceWith('Explain this'))
  expect(reply.mock.calls.at(-1)?.[0].id).not.toBe(2)
  accept()
  await pending
  expect(reply.mock.calls.at(-1)?.[0]).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  dispatcher.dispose()
  await expect(receive({ jsonrpc: '2.0', id: 3, method: 'ping' })).rejects.toThrow('authority')
})

test('large responses have a bounded cache without forgetting request identities or replaying actions', async () => {
  const { initialize, receive, reply, api } = fixture()
  vi.mocked(api.resourceRead).mockResolvedValue({
    contents: [{ uri: 'app://data', text: 'x'.repeat(600_000) }],
  })
  await initialize()
  for (let id = 2; id < 7; id++)
    await receive({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri: 'app://data' } })
  expect(api.resourceRead).toHaveBeenCalledTimes(5)
  await receive({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'app://data' } })
  expect(api.resourceRead).toHaveBeenCalledTimes(5)
  expect(reply.mock.calls.at(-1)?.[0].error.message).toContain('no longer retained')
})

test('a fresh mount does not replay anything and a new explicit action gets a new operation identity', async () => {
  const request = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: {} },
  } as Record<string, WidgetJson>
  const first = fixture()
  await first.initialize()
  await first.receive(request)
  await first.receive(request)
  expect(first.api.toolCall).toHaveBeenCalledTimes(1)
  const firstId = vi.mocked(first.api.toolCall).mock.calls[0][1]
  first.dispatcher.dispose()
  const next = fixture()
  await next.initialize()
  expect(next.api.toolCall).not.toHaveBeenCalled()
  await next.receive(request)
  expect(next.api.toolCall).toHaveBeenCalledTimes(1)
  expect(vi.mocked(next.api.toolCall).mock.calls[0][1]).not.toBe(firstId)
})

test('a fresh mount does not automatically replay an unknown action and respects the authoritative unresolved gate', async () => {
  const request = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'refresh', arguments: {} },
  } as Record<string, WidgetJson>
  const next = fixture()
  vi.mocked(next.api.toolCall).mockImplementation(async (_widget, operationId) => ({
    operationId,
    status: 'not_sent',
    errorCode: 'mcp_app_operation_unresolved',
  }))
  await next.initialize()
  expect(next.api.toolCall).not.toHaveBeenCalled()
  await next.receive(request)
  expect(next.api.toolCall).toHaveBeenCalledTimes(1)
  expect(next.reply.mock.calls.at(-1)?.[0].error.data.status).toBe('not_sent')
  expect(next.reply.mock.calls.at(-1)?.[0].error.data.errorCode).toBe(
    'mcp_app_operation_unresolved'
  )
  expect(next.api.operationRead).not.toHaveBeenCalled()
})
