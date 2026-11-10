import { requestLocalExecutor } from '@/host/localExecutor'
import type { RuntimeTaskAddress } from '@/types/api'
import { widgetContentSha256 } from '@/features/widgets/contentHash'
import { isBoundedWidgetJson } from '@/features/widgets/bridge'
import { validateWidgetReference, type WidgetRequest } from './widgetApi'
import {
  isMcpAppReadResult,
  isMcpAppToolCallResult,
  isMcpAppResourceReadResult,
  isMcpAppResourceContentReadResult,
  type WidgetRef,
  type McpAppReadResult,
  type McpAppToolCallResult,
} from '../../../shared/generated/contracts'

export type McpAppHostView = McpAppReadResult & {
  allowedTools?: string[]
  resourcesEnabled?: boolean
  toolInfo?: unknown
}
const RESOURCE_BYTES = 768 * 1024
const SHA = /^[a-f0-9]{64}$/

/** The original retained connection is routing input; server names and UI URIs are not. */
export function createMcpAppApi(
  address: RuntimeTaskAddress,
  threadId: string,
  supplied?: WidgetRequest
) {
  const request: WidgetRequest =
    supplied ??
    ((method, params, signal) =>
      requestLocalExecutor('runtime.mcpApps.request', { address, method, params }, { signal }))
  const binding = (reference: WidgetRef) => {
    const widget = validateWidgetReference(reference, threadId)
    if (
      !widget.mcpApp ||
      widget.executionMode !== 'isolated_html' ||
      !widget.mcpApp.connectionId ||
      widget.mcpApp.connectionId.length > 256
    )
      throw new Error('artifact_unavailable: an original MCP App connection is required')
    return {
      threadId,
      widgetId: widget.widgetId,
      revision: widget.revision,
      connectionId: widget.mcpApp.connectionId,
    }
  }
  const operation = async (
    method: string,
    reference: WidgetRef,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpAppToolCallResult> => {
    signal?.throwIfAborted()
    const result = await request<unknown>(method, { ...params, ...binding(reference) }, signal)
    if (
      !isMcpAppToolCallResult(result) ||
      result.operationId !== params.operationId ||
      !isBoundedWidgetJson(result, 1024 * 1024)
    )
      throw new Error('invalid MCP App operation receipt')
    return result
  }
  return {
    async read(reference: WidgetRef, signal?: AbortSignal): Promise<McpAppHostView> {
      signal?.throwIfAborted()
      const result = await request<unknown>('mcp/apps/read', binding(reference), signal)
      if (!isMcpAppReadResult(result) || !isBoundedWidgetJson(result, 1024 * 1024))
        throw new Error('artifact_unavailable: invalid MCP App view')
      const widget = validateWidgetReference(result.widget, threadId)
      if (
        widget.widgetId !== reference.widgetId ||
        widget.revision !== reference.revision ||
        widget.sha256 !== reference.sha256 ||
        widget.mcpApp?.connectionId !== reference.mcpApp?.connectionId
      )
        throw new Error('artifact_unavailable: MCP App identity changed')
      const allowed = (result as McpAppHostView).allowedTools
      if (
        allowed !== undefined &&
        (!Array.isArray(allowed) ||
          allowed.length > 256 ||
          allowed.some(name => typeof name !== 'string' || !name || name.length > 256))
      )
        throw new Error('artifact_unavailable: invalid MCP App tool policy')
      return result
    },
    toolCall(
      reference: WidgetRef,
      operationId: string,
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal
    ) {
      return operation(
        'mcp/apps/toolCall',
        reference,
        { operationId, name, arguments: args },
        signal
      )
    },
    operationRead(reference: WidgetRef, operationId: string, signal?: AbortSignal) {
      return operation('mcp/apps/operationRead', reference, { operationId }, signal)
    },
    async resourceRead(
      reference: WidgetRef,
      uri: string,
      signal?: AbortSignal
    ): Promise<Record<string, unknown>> {
      signal?.throwIfAborted()
      const params = binding(reference)
      const response = await request<unknown>('mcp/apps/resourceRead', { ...params, uri }, signal)
      if (!isMcpAppResourceReadResult(response)) throw new Error('invalid MCP App resource receipt')
      const resource = response.resource
      if (
        resource.uri !== uri ||
        resource.encoding !== 'json' ||
        !SHA.test(resource.sha256) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(resource.resourceId) ||
        !Number.isSafeInteger(resource.bytes) ||
        resource.bytes < 1 ||
        resource.bytes > RESOURCE_BYTES ||
        !Number.isSafeInteger(resource.contentCount) ||
        resource.contentCount < 1 ||
        resource.contentCount > 128
      )
        throw new Error('invalid MCP App resource identity or budget')
      const bytes = new Uint8Array(resource.bytes)
      let offset = 0
      while (offset < bytes.length) {
        signal?.throwIfAborted()
        const chunk = await request<unknown>(
          'mcp/apps/resourceContentRead',
          {
            ...params,
            resourceId: resource.resourceId,
            sha256: resource.sha256,
            offset,
          },
          signal
        )
        if (
          !isMcpAppResourceContentReadResult(chunk) ||
          chunk.resourceId !== resource.resourceId ||
          chunk.sha256 !== resource.sha256 ||
          chunk.bytes !== bytes.length ||
          chunk.offset !== offset ||
          !Number.isSafeInteger(chunk.nextOffset) ||
          chunk.nextOffset <= offset ||
          chunk.nextOffset > bytes.length ||
          chunk.nextOffset - offset > 32 * 1024 ||
          chunk.dataBase64.length > 43692 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.dataBase64)
        )
          throw new Error('invalid MCP App resource chunk')
        const decoded = atob(chunk.dataBase64)
        if (decoded.length !== chunk.nextOffset - offset)
          throw new Error('MCP App resource chunk size mismatch')
        for (let index = 0; index < decoded.length; index++)
          bytes[offset + index] = decoded.charCodeAt(index)
        offset = chunk.nextOffset
      }
      signal?.throwIfAborted()
      if ((await widgetContentSha256(bytes)) !== resource.sha256)
        throw new Error('MCP App resource hash mismatch')
      const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (
        !isBoundedWidgetJson(result, RESOURCE_BYTES) ||
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        !Array.isArray(result.contents) ||
        result.contents.length !== resource.contentCount
      )
        throw new Error('invalid MCP App resource contents')
      return result
    },
  }
}
export type McpAppApi = ReturnType<typeof createMcpAppApi>
