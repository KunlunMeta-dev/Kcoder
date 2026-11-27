import { requestLocalExecutor } from '@/host/localExecutor'
import type { RuntimeTaskAddress } from '@/types/api'
import { widgetContentSha256 } from '@/features/widgets/contentHash'
import { WIDGET_LIMITS } from '@/features/widgets/types'
import {
  isWidgetRef,
  type WidgetRef,
  type WidgetListResult,
  type WidgetContentReadResult,
  type WidgetReadResult,
  type WidgetRenderReceiptParams,
} from '../../../shared/generated/contracts'

export type WidgetRequest = <T>(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<T>

export function validateWidgetReference(value: unknown, threadId?: string): WidgetRef {
  if (
    !isWidgetRef(value) ||
    (threadId && value.threadId !== threadId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.widgetId) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > WIDGET_LIMITS.sourceBytes ||
    [value.threadId, value.turnId, value.attemptId, value.toolCallId].some(
      id => !id || id.length > 256
    )
  )
    throw new Error('artifact_unavailable: invalid widget reference')
  return value
}

export function createWidgetApi(
  address: RuntimeTaskAddress,
  threadId: string,
  suppliedRequest?: WidgetRequest
) {
  const request: WidgetRequest =
    suppliedRequest ??
    ((method, params, signal) =>
      requestLocalExecutor('runtime.widgets.request', { address, method, params }, { signal }))
  const contentCache = new Map<string, { sha256: string; source: string; bytes: number }>()
  return {
    async list(signal?: AbortSignal): Promise<WidgetRef[]> {
      const widgets: WidgetRef[] = []
      let offset = 0
      for (let page = 0; page < 11; page++) {
        signal?.throwIfAborted()
        const result = await request<WidgetListResult>(
          'widget/list',
          { threadId, offset, limit: 50 },
          signal
        )
        if (!result || !Array.isArray(result.widgets) || result.widgets.length > 50)
          throw new Error('artifact_unavailable: invalid widget listing')
        widgets.push(...result.widgets.map(widget => validateWidgetReference(widget, threadId)))
        if (widgets.length > 512) throw new Error('widget_quota: too many widget revisions')
        if (result.nextOffset == null) return widgets
        if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset)
          throw new Error('artifact_unavailable: invalid widget listing cursor')
        offset = result.nextOffset
      }
      throw new Error('widget_quota: widget listing exceeded its page limit')
    },
    async read(widgetId: string, revision: number, signal?: AbortSignal) {
      const result = await request<WidgetReadResult>(
        'widget/read',
        { threadId, widgetId, revision },
        signal
      )
      const reference = validateWidgetReference(result?.widget, threadId)
      if (reference.widgetId !== widgetId || reference.revision !== revision)
        throw new Error('artifact_unavailable: widget identity changed')
      return reference
    },
    async content(reference: WidgetRef, signal: AbortSignal): Promise<string> {
      const widget = validateWidgetReference(reference, threadId)
      const cacheKey = `${widget.widgetId}:${widget.revision}`
      signal.throwIfAborted()
      const cached = contentCache.get(cacheKey)
      if (cached?.sha256 === widget.sha256 && cached.bytes === widget.bytes) return cached.source
      const bytes = new Uint8Array(widget.bytes)
      let offset = 0
      while (offset < widget.bytes) {
        signal.throwIfAborted()
        const chunk = await request<WidgetContentReadResult>(
          'widget/content/read',
          { threadId, widgetId: widget.widgetId, revision: widget.revision, offset },
          signal
        )
        if (
          !chunk ||
          chunk.widgetId !== widget.widgetId ||
          chunk.revision !== widget.revision ||
          chunk.sha256 !== widget.sha256 ||
          chunk.bytes !== widget.bytes ||
          chunk.offset !== offset ||
          !Number.isSafeInteger(chunk.nextOffset) ||
          chunk.nextOffset <= offset ||
          chunk.nextOffset > widget.bytes ||
          chunk.nextOffset - offset > 32 * 1024 ||
          typeof chunk.dataBase64 !== 'string' ||
          chunk.dataBase64.length > 43_692 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.dataBase64)
        )
          throw new Error('artifact_unavailable: invalid widget content chunk')
        const decoded = atob(chunk.dataBase64)
        if (decoded.length !== chunk.nextOffset - offset)
          throw new Error('artifact_unavailable: widget chunk size mismatch')
        for (let index = 0; index < decoded.length; index++)
          bytes[offset + index] = decoded.charCodeAt(index)
        offset = chunk.nextOffset
      }
      signal.throwIfAborted()
      if ((await widgetContentSha256(bytes)) !== widget.sha256)
        throw new Error('artifact_unavailable: widget content hash mismatch')
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      contentCache.delete(cacheKey)
      contentCache.set(cacheKey, { sha256: widget.sha256, source, bytes: widget.bytes })
      while (
        contentCache.size > 6 ||
        [...contentCache.values()].reduce((total, item) => total + item.bytes, 0) > 3 * 1024 * 1024
      )
        contentCache.delete(contentCache.keys().next().value!)
      return source
    },
    receipt(widget: WidgetRef, status: 'rendered' | 'failed', errorCode?: string) {
      const params: WidgetRenderReceiptParams = {
        widget: { threadId, widgetId: widget.widgetId, revision: widget.revision },
        turnId: widget.turnId,
        attemptId: widget.attemptId,
        toolCallId: widget.toolCallId,
        status,
        ...(errorCode ? { errorCode } : {}),
      }
      return request('widget/render/receipt', params)
    },
  }
}

export type WidgetApi = ReturnType<typeof createWidgetApi>
