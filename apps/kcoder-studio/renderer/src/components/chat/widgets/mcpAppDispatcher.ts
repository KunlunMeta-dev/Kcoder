import { widgetContentSha256 } from '@/features/widgets/contentHash'
import { createRandomUuid } from '@/lib/random-id'
import { isBoundedWidgetJson, jsonByteLength } from '@/features/widgets/bridge'
import type { WidgetAppMessageContext } from '@/features/widgets'
import type { WidgetJson, WidgetTheme } from '@/features/widgets/types'
import type { McpAppApi, McpAppHostView } from '@/kcoder/mcpAppApi'
import type { WidgetRef } from '../../../../../shared/generated/contracts'

const VERSION = '2026-01-26'
type RpcObject = Record<string, WidgetJson>
class AppError extends Error {
  readonly code: number
  readonly data?: RpcObject
  constructor(message: string, code = -32000, data?: RpcObject) {
    super(message)
    this.code = code
    this.data = data
  }
}
const object = (value: unknown): value is RpcObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
interface Options {
  widget: WidgetRef
  api: McpAppApi
  isCurrent: () => boolean
  theme: () => WidgetTheme
  requestDraft: (text: string) => Promise<void>
}

/** Only the native frame host may invoke this dispatcher after source/lease validation. */
export function createMcpAppDispatcher(options: Options) {
  const abort = new AbortController()
  const instance = createRandomUuid()
  const requests = new Map<
    string,
    { signature: string; response: Promise<RpcObject>; retainedBytes: number; id: string | number }
  >()
  let responseCacheBytes = 0
  let view: McpAppHostView | undefined
  let initialized = false
  let initializing = false
  let disposed = false
  let reply: WidgetAppMessageContext['reply'] | undefined
  let activeRequests = 0
  const current = () => !disposed && !abort.signal.aborted && options.isCurrent()
  const ensureCurrent = () => {
    if (!current()) throw new AppError('MCP App conversation authority is no longer available')
  }
  const send = (message: RpcObject) => {
    ensureCurrent()
    if (!isBoundedWidgetJson(message, 1024 * 1024))
      throw new AppError('MCP App response exceeds the host budget')
    reply?.(message)
  }
  const notify = (method: string, params: RpcObject) => send({ jsonrpc: '2.0', method, params })
  const loadView = async () => {
    ensureCurrent()
    const result = await options.api.read(options.widget, abort.signal)
    ensureCurrent()
    if (result.protocolVersion !== VERSION)
      throw new AppError('Unsupported MCP Apps protocol version', -32602)
    view = result
    return result
  }
  const assertLive = () => {
    ensureCurrent()
    if (!initialized || !view?.live)
      throw new AppError(
        'This retained MCP App is read-only; its original connection is unavailable'
      )
  }
  const hostContext = (): RpcObject => {
    const theme = options.theme()
    return {
      theme: theme.colorScheme,
      locale: theme.locale,
      platform: 'desktop',
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      ...(object(view?.toolInfo)
        ? { toolInfo: { id: options.widget.toolCallId, tool: view.toolInfo } }
        : {}),
      styles: {
        variables: {
          '--color-background-primary': theme.background,
          '--color-text-primary': theme.foreground,
          '--color-text-secondary': theme.muted,
          '--color-border-primary': theme.border,
          '--font-sans': theme.fontFamily,
        },
      },
    }
  }
  const initialize = async (params: RpcObject) => {
    if (initialized || initializing) throw new AppError('MCP App has already initialized', -32600)
    if (
      params.protocolVersion !== VERSION ||
      !object(params.appInfo) ||
      !object(params.appCapabilities)
    )
      throw new AppError(
        'ui/initialize requires protocolVersion, appInfo and appCapabilities',
        -32602
      )
    initializing = true
    try {
      const value = await loadView()
      const hostCapabilities: RpcObject = {
        sandbox: {
          permissions: {},
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
        },
      }
      if (value.live) {
        if (value.resourcesEnabled === true) hostCapabilities.serverResources = {}
        if (value.allowedTools?.length) hostCapabilities.serverTools = {}
      }
      // ui/notifications/initialized completes the handshake before data is sent.
      return {
        protocolVersion: VERSION,
        hostCapabilities,
        hostInfo: {
          name: 'kcoder-studio',
          version:
            typeof __KCODER_STUDIO_APP_VERSION__ === 'string'
              ? __KCODER_STUDIO_APP_VERSION__
              : 'development',
        },
        hostContext: hostContext(),
      }
    } catch (error) {
      initializing = false
      throw error
    }
  }
  const toolCall = async (params: RpcObject, id: string) => {
    assertLive()
    if (
      typeof params.name !== 'string' ||
      !view?.allowedTools?.includes(params.name) ||
      (params.arguments !== undefined && !object(params.arguments))
    )
      throw new AppError('Tool is not app-visible in this original server connection', -32602)
    // Identity is stable for this frame/request. Lost responses are reconciled, never replayed.
    const operationId = `app-${await widgetContentSha256(
      new TextEncoder().encode(
        JSON.stringify([
          instance,
          options.widget.mcpApp!.connectionId,
          options.widget.threadId,
          options.widget.widgetId,
          options.widget.revision,
          id,
        ])
      )
    )}`
    let result
    try {
      result = await options.api.toolCall(
        options.widget,
        operationId,
        params.name,
        params.arguments ?? {},
        abort.signal
      )
    } catch {
      ensureCurrent()
      try {
        result = await options.api.operationRead(options.widget, operationId, abort.signal)
      } catch {
        throw new AppError(
          'The tool outcome is unknown. Reconcile this operation before another action.',
          -32003,
          { operationId, status: 'outcome_unknown' }
        )
      }
    }
    ensureCurrent()
    if (result.status !== 'completed' || !object(result.result))
      throw new AppError(
        result.status === 'outcome_unknown' || result.status === 'executing'
          ? 'The tool outcome is not confirmed. Do not repeat this action.'
          : 'The tool action was not completed.',
        -32003,
        {
          operationId,
          status: result.status,
          errorCode: result.errorCode ?? null,
        }
      )
    return result.result
  }
  const dispatch = async (method: string, params: RpcObject, id: string): Promise<RpcObject> => {
    if (method === 'ui/initialize') return initialize(params)
    if (!initialized)
      throw new AppError('Complete ui/initialize before using the App bridge', -32002)
    if (method === 'ping') return {}
    if (method === 'tools/call') return toolCall(params, id)
    if (method === 'resources/read') {
      assertLive()
      if (view?.resourcesEnabled !== true)
        throw new AppError('This original server has no resource-read capability')
      if (typeof params.uri !== 'string' || !params.uri || params.uri.length > 2048)
        throw new AppError('resources/read requires a bounded resource URI', -32602)
      const result = await options.api.resourceRead(options.widget, params.uri, abort.signal)
      ensureCurrent()
      if (!object(result)) throw new AppError('Invalid resource response')
      return result
    }
    if (method === 'ui/request-display-mode') return { mode: 'inline' }
    if (method === 'ui/message') {
      ensureCurrent()
      if (
        params.role !== 'user' ||
        !object(params.content) ||
        params.content.type !== 'text' ||
        typeof params.content.text !== 'string' ||
        !params.content.text.trim() ||
        params.content.text.length > 4000
      )
        throw new AppError('Only a bounded user text message can be added to the draft', -32602)
      await options.requestDraft(params.content.text)
      ensureCurrent()
      return {}
    }
    // No external links, automatic sends, camera, microphone, context mutation or arbitrary RPC.
    throw new AppError('This App method is not supported by the host', -32601)
  }
  return {
    async receive(context: WidgetAppMessageContext) {
      ensureCurrent()
      if (
        context.widget.widgetId !== options.widget.widgetId ||
        context.widget.revision !== options.widget.revision ||
        context.widget.threadId !== options.widget.threadId ||
        context.widget.sha256 !== options.widget.sha256
      )
        throw new AppError('MCP App frame identity does not match its retained artifact')
      const message = context.message
      if (
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        !isBoundedWidgetJson(message, 24 * 1024)
      )
        return
      reply = context.reply
      const hasId = Object.hasOwn(message, 'id')
      if (!hasId) {
        if (
          message.method === 'ui/notifications/initialized' &&
          initializing &&
          view &&
          !initialized
        ) {
          initialized = true
          initializing = false
          notify('ui/notifications/tool-input', {
            arguments: object(view.toolInput) ? view.toolInput : {},
          })
          notify('ui/notifications/tool-result', {
            content: view.toolContent as WidgetJson[],
            ...(view.structuredContent != null
              ? { structuredContent: view.structuredContent as WidgetJson }
              : {}),
            ...(view.resultMeta != null ? { _meta: view.resultMeta as WidgetJson } : {}),
          })
        }
        if (
          message.method === 'ui/notifications/size-changed' &&
          initialized &&
          object(message.params) &&
          typeof message.params.height === 'number' &&
          Number.isFinite(message.params.height) &&
          message.params.height >= 0 &&
          (message.params.width === undefined ||
            (typeof message.params.width === 'number' &&
              Number.isFinite(message.params.width) &&
              message.params.width >= 0))
        )
          context.resize(
            message.params.height,
            typeof message.params.width === 'number' ? message.params.width : undefined
          )
        return
      }
      const id = message.id
      if (!(
        (typeof id === 'string' && id.length <= 128) ||
        (typeof id === 'number' && Number.isSafeInteger(id))
      ))
        return
      const key = `${typeof id}:${id}`
      if (message.params !== undefined && !object(message.params)) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'App params must be an object' },
        })
        return
      }
      const params = message.params ?? {}
      const signature = await widgetContentSha256(
        new TextEncoder().encode(JSON.stringify([message.method, params]))
      )
      ensureCurrent()
      let entry = requests.get(key)
      if (entry && entry.signature !== signature) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32600,
            message: 'A request identity cannot be reused for another action',
          },
        })
        return
      }
      if (!entry) {
        if (requests.size >= 128 || activeRequests >= 8) {
          send({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'MCP App request budget reached; action was not sent' },
          })
          return
        }
        activeRequests++
        const actionIdentity = key
        const response = Promise.resolve()
          .then(() => dispatch(message.method as string, params, actionIdentity))
          .then(result => ({ jsonrpc: '2.0', id, result }) as RpcObject)
          .catch((reason: unknown): RpcObject => {
            const error =
              reason instanceof AppError
                ? reason
                : new AppError('MCP App request could not be completed')
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: error.code,
                message: error.message,
                ...(error.data ? { data: error.data } : {}),
              },
            }
          })
          .then(result => {
            const retained = requests.get(key)
            if (retained) {
              retained.retainedBytes = jsonByteLength(result)
              responseCacheBytes += retained.retainedBytes
              // Preserve identities after evicting response bodies: a duplicate must
              // never execute another action just because its UI cache was bounded.
              for (const [olderKey, older] of requests) {
                if (responseCacheBytes <= 2 * 1024 * 1024) break
                if (olderKey === key || older.retainedBytes === 0) continue
                const evicted: RpcObject = {
                  jsonrpc: '2.0',
                  id: older.id,
                  error: {
                    code: -32003,
                    message:
                      'This response is no longer retained by the view. Do not repeat an action; reconcile its operation receipt.',
                  },
                }
                responseCacheBytes -= older.retainedBytes
                older.retainedBytes = 0
                older.response = Promise.resolve(evicted)
              }
            }
            return result
          })
          .finally(() => {
            activeRequests--
          })
        entry = { signature, response, retainedBytes: 0, id }
        requests.set(key, entry)
      }
      const response = await entry.response
      if (current()) context.reply(response)
    },
    updateContext() {
      if (!initialized || !current()) return
      try {
        notify('ui/notifications/host-context-changed', hostContext())
      } catch {
        /* Native revocation can precede React's view cleanup. */
      }
    },
    dispose() {
      if (disposed) return
      if (initialized && current()) {
        try {
          send({
            jsonrpc: '2.0',
            id: `teardown-${instance}`,
            method: 'ui/resource-teardown',
            params: { reason: 'conversation view closed' },
          })
        } catch {
          /* A revoked native lease has already ended this channel. */
        }
      }
      disposed = true
      abort.abort()
      requests.clear()
      view = undefined
      reply = undefined
    },
  }
}
export type McpAppDispatcher = ReturnType<typeof createMcpAppDispatcher>
